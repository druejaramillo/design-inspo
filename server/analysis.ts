import "dotenv/config";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z, ZodError } from "zod";
import { analysisSchema, type Analysis, type AnalysisProvider, type CatalogItem, type Taxonomy } from "../shared/schema.js";

const ANALYSIS_TIMEOUT_MS = 240_000;
const MAX_PROCESS_OUTPUT = 64 * 1024;
const PI_VISION_SYSTEM_PROMPT = "You are a dedicated vision analyst for a private design-reference catalog. The attached image and the requested JSON shape are your only inputs. Do not use tools, inspect the repository, start a workflow, or ask questions. Return only the requested JSON object without prose or Markdown fences.";

const piEventSchema = z.object({
  type: z.string(),
  message: z.unknown().optional(),
  success: z.boolean().optional(),
  finalError: z.string().optional(),
  aborted: z.boolean().optional(),
});

const piAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stopReason: z.string(),
  errorMessage: z.string().optional(),
});

/** Defaults image analysis to GPT-6 Luna through Pi's OpenAI Codex subscription provider. */
export function piVisionModel() {
  return process.env.PI_VISION_MODEL?.trim() || "openai-codex/gpt-6-luna";
}

function piVisionExtension() {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const extension = process.env.PI_VISION_EXTENSION?.trim() || join(agentDir, "npm", "node_modules", "@monotykamary", "pi-better-openai", "index.ts");
  return resolve(extension.replace(/^~(?=$|\/)/, () => homedir()));
}

type AnalysisErrorCode = "canceled" | "timeout" | "unavailable" | "provider" | "invalid-output";

export class AnalysisError extends Error {
  constructor(
    readonly code: AnalysisErrorCode,
    message: string,
    readonly diagnostic: string,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

function analysisPrompt(taxonomy: Taxonomy) {
  const tags = taxonomy.groups.flatMap((group) => group.tags.map((tag) => `${tag.id} (${tag.label})`)).join(", ");
  return `Analyze this design inspiration image for a private design-reference catalog. Return ONLY one JSON object with this exact shape:
{
  "title": "a concise descriptive title for this reference",
  "palette": [{"hex":"#112233","role":"background"}],
  "style": ["short visual-style descriptors"],
  "tone": ["short tone descriptors"],
  "layout": ["short composition descriptors"],
  "typography": ["short type descriptors"],
  "uiMotifs": ["short interface or art-direction motifs"],
  "notes": "a concise evidence-based visual analysis",
  "suggestedTagIds": ["only IDs from the allowed list"],
  "heroPrompt": "a detailed, original image-generation prompt for the hero visual, or null when no distinct hero image is visible"
}
Rules: title the visual or design direction in 3-8 descriptive words. Prefer an original visual description over filenames, generic labels, marketing copy, or text you cannot read confidently. Keep every descriptor list to 3-5 entries, notes to two sentences, and heroPrompt under 140 words. Provide 3-6 palette colors when possible, never invent unreadable text, never use brand names/logos/copyrighted characters in heroPrompt, and describe the visual techniques and composition instead. Do not use tools; the attached image is the only reference you need. Allowed tag IDs: ${tags}.`;
}

function correctionPrompt(taxonomy: Taxonomy, issues: string) {
  return `${analysisPrompt(taxonomy)}

Your previous response did not match the required JSON shape: ${issues}. Return a corrected JSON object only.`;
}

function compact(text: string, limit = 500) {
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function appendOutput(current: string, chunk: string) {
  const next = `${current}${chunk}`;
  return next.length > MAX_PROCESS_OUTPUT ? next.slice(-MAX_PROCESS_OUTPUT) : next;
}

function jsonFromText(text: string, provider: "Pi" | "OpenAI") {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch {
        // Report malformed JSON through the same retry path as missing JSON.
      }
    }
    throw new AnalysisError("invalid-output", `${provider} returned an incomplete analysis. Try again.`, `No valid JSON object was found in the final ${provider} response.`);
  }
}

function createPiEventReader() {
  let pending = "";
  let finalMessage: unknown;
  let retryError: string | undefined;
  let aborted = false;

  const readLine = (line: string) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = piEventSchema.safeParse(value);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.type === "message_end" && event.message && typeof event.message === "object" && "role" in event.message && event.message.role === "assistant") {
      finalMessage = event.message;
    }
    if (event.type === "auto_retry_end" && event.success === false) retryError = event.finalError || "Pi exhausted its provider retries.";
    if (event.type === "agent_settled") aborted = event.aborted === true;
  };

  return {
    write(chunk: string) {
      const lines = `${pending}${chunk}`.split("\n");
      pending = lines.pop()!;
      lines.forEach(readLine);
    },
    result() {
      if (pending) {
        readLine(pending);
        pending = "";
      }
      if (aborted) throw new AnalysisError("canceled", "Analysis canceled.", "Pi aborted the analysis run.");
      if (retryError) throw new AnalysisError("provider", "Pi could not analyze this image.", compact(retryError));
      const parsed = piAssistantMessageSchema.safeParse(finalMessage);
      if (!parsed.success) {
        throw new AnalysisError("invalid-output", "Pi returned an incomplete analysis. Try again.", "No completed assistant message was found in the Pi event stream.");
      }
      const message = parsed.data;
      if (message.stopReason === "aborted") throw new AnalysisError("canceled", "Analysis canceled.", compact(message.errorMessage || "Pi aborted the assistant response."));
      if (message.stopReason === "error") throw new AnalysisError("provider", "Pi could not analyze this image.", compact(message.errorMessage || "Pi returned a provider error."));
      if (message.stopReason !== "stop") {
        throw new AnalysisError("invalid-output", "Pi returned an incomplete analysis. Try again.", `Pi stopped with reason ${message.stopReason}.`);
      }
      const text = message.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      return jsonFromText(text, "Pi");
    },
  };
}

/** Reads only the final completed Pi assistant message, never streamed deltas or tool results. */
export function parsePiEvents(output: string) {
  const events = createPiEventReader();
  events.write(output);
  return events.result();
}

function completeAnalysis(value: unknown, provider: AnalysisProvider): Analysis {
  const object = value as Record<string, unknown>;
  return analysisSchema.parse({
    ...object,
    version: 1,
    provider,
    analyzedAt: new Date().toISOString(),
  });
}

function schemaIssues(error: unknown) {
  if (!(error instanceof ZodError)) return null;
  return error.issues.slice(0, 6).map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`).join("; ");
}

async function preparePiVisionRun() {
  const model = piVisionModel();
  if (!/^(openai-codex|openai)\//.test(model)) {
    throw new AnalysisError("unavailable", "Pi fast analysis requires an OpenAI or OpenAI Codex model.", `The configured vision model does not support OpenAI Fast mode: ${model}.`);
  }
  const extension = piVisionExtension();
  try {
    await access(extension, constants.R_OK);
  } catch {
    throw new AnalysisError("unavailable", "Pi fast analysis requires pi-better-openai. Install it with Pi or set PI_VISION_EXTENSION to its index.ts path.", `The pi-better-openai extension is not readable at ${extension}.`);
  }
  const cwd = await mkdtemp(join(tmpdir(), "field-notes-pi-"));
  try {
    const configDirectory = join(cwd, ".pi", "extensions");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(join(configDirectory, "pi-better-openai.json"), JSON.stringify({
      serviceTier: "fast",
      // This extension ignores its configured startup tier when persistState is false.
      persistState: true,
      active: true,
      desiredActive: true,
      notifyOnModelSwitch: false,
      supportedModels: [model],
      usage: { enabled: false, autoRedeemBankedResets: false },
      image: { enabled: false },
      websearch: { enabled: false },
      decisions: { enabled: false },
      live: { enabled: false },
      pets: { enabled: false },
    }), "utf8");
    return { cwd, extension, model };
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

type PiCommandResult = { value: unknown };

async function runPiCommand(mediaPath: string, prompt: string, signal?: AbortSignal): Promise<PiCommandResult> {
  if (signal?.aborted) throw new AnalysisError("canceled", "Analysis canceled.", "The analysis request was canceled before Pi started.");
  const { cwd, extension, model } = await preparePiVisionRun();
  return new Promise<PiCommandResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AnalysisError("canceled", "Analysis canceled.", "The analysis request was canceled before Pi started."));
      return;
    }
    const args = [
      "--print", "--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-mcp",
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
      "--extension", extension, "--model", model, "--thinking", "high",
      "--system-prompt", PI_VISION_SYSTEM_PROMPT,
      "--", `@${mediaPath}`, prompt,
    ];
    const child = spawn("pi", args, { cwd, env: process.env });
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const events = createPiEventReader();
    let stderr = "";
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: PiCommandResult | AnalysisError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      if (result instanceof AnalysisError) reject(result);
      else resolve(result);
    };

    const stop = (error: AnalysisError) => {
      if (settled) return;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
      finish(error);
    };

    const cancel = () => stop(new AnalysisError("canceled", "Analysis canceled.", "The analysis request was canceled before Pi finished."));
    const timeout = setTimeout(() => stop(new AnalysisError("timeout", "Analysis timed out after four minutes. Try again.", `Pi did not finish within ${ANALYSIS_TIMEOUT_MS}ms.`)), ANALYSIS_TIMEOUT_MS);

    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (data: string) => events.write(data));
    child.stderr.on("data", (data: string) => (stderr = appendOutput(stderr, data)));
    child.once("error", (error) => {
      const unavailable = (error as NodeJS.ErrnoException).code === "ENOENT";
      finish(new AnalysisError(
        unavailable ? "unavailable" : "provider",
        unavailable ? "Pi is not available on this machine. Install Pi and make sure pi is on PATH." : "Pi could not start analysis.",
        compact(error.message),
      ));
    });
    child.once("close", (code, closeSignal) => {
      if (forceKill) clearTimeout(forceKill);
      if (settled) return;
      if (code === 0) {
        try {
          finish({ value: events.result() });
        } catch (error) {
          finish(error instanceof AnalysisError ? error : new AnalysisError("invalid-output", "Pi returned an incomplete analysis. Try again.", compact(String(error))));
        }
        return;
      }
      let eventError: string | undefined;
      try {
        events.result();
      } catch (error) {
        if (error instanceof AnalysisError && error.code === "provider") eventError = error.diagnostic;
      }
      finish(new AnalysisError(
        "provider",
        "Pi could not analyze this image.",
        eventError || compact(stderr) || `Pi exited with code ${code ?? "unknown"} (${closeSignal ?? "no signal"}).`,
      ));
    });
  }).finally(() => rm(cwd, { recursive: true, force: true }));
}

async function validPiAnalysis(mediaPath: string, prompt: string, signal?: AbortSignal) {
  const result = await runPiCommand(mediaPath, prompt, signal);
  try {
    return completeAnalysis(result.value, "pi");
  } catch (error) {
    const issues = schemaIssues(error);
    if (issues) throw new AnalysisError("invalid-output", "Pi returned an incomplete analysis. Try again.", issues);
    throw error;
  }
}

async function analyzeWithPi(mediaPath: string, taxonomy: Taxonomy, signal?: AbortSignal): Promise<Analysis> {
  try {
    return await validPiAnalysis(mediaPath, analysisPrompt(taxonomy), signal);
  } catch (error) {
    if (!(error instanceof AnalysisError) || error.code !== "invalid-output") throw error;
    return validPiAnalysis(mediaPath, correctionPrompt(taxonomy, error.diagnostic), signal);
  }
}

async function analyzeWithOpenAI(mediaPath: string, taxonomy: Taxonomy, signal?: AbortSignal): Promise<Analysis> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new AnalysisError("unavailable", "OPENAI_API_KEY is required for the OpenAI analysis provider.", "OPENAI_API_KEY was not configured.");
  const image = await readFile(mediaPath);
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL ?? "gpt-5.6-luna",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a precise design analyst. Reply with valid JSON only." },
        {
          role: "user",
          content: [
            { type: "text", text: analysisPrompt(taxonomy) },
            { type: "image_url", image_url: { url: `data:image/webp;base64,${image.toString("base64")}`, detail: "high" } },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = compact(await response.text());
    throw new AnalysisError("provider", `OpenAI vision could not analyze this image (${response.status}).`, body || `OpenAI returned HTTP ${response.status}.`);
  }
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new AnalysisError("invalid-output", "OpenAI returned an incomplete analysis. Try again.", "OpenAI returned no message content.");
  try {
    return completeAnalysis(jsonFromText(content, "OpenAI"), "openai");
  } catch (error) {
    if (error instanceof AnalysisError) throw error;
    const issues = schemaIssues(error);
    throw new AnalysisError("invalid-output", "OpenAI returned an incomplete analysis. Try again.", issues ?? compact(String(error)));
  }
}

export function analysisErrorMessage(error: unknown) {
  if (error instanceof AnalysisError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "Analysis canceled.";
  return "Analysis failed unexpectedly. Try again.";
}

export function analysisErrorStatus(error: unknown) {
  if (error instanceof AnalysisError && error.code === "timeout") return 504;
  if (error instanceof AnalysisError) return 502;
  return null;
}

export function analysisStatusAfterError(error: unknown): CatalogItem["analysisStatus"] {
  return analysisErrorMessage(error) === "Analysis canceled." ? "canceled" : "failed";
}

export function analysisDiagnostic(error: unknown) {
  return error instanceof AnalysisError ? error.diagnostic : compact(error instanceof Error ? error.message : String(error));
}

export async function analyzeItem(item: CatalogItem, mediaPath: string, taxonomy: Taxonomy, provider: AnalysisProvider, signal?: AbortSignal) {
  if (!item.media) throw new AnalysisError("invalid-output", "This item needs an image before it can be analyzed.", "The catalog item has no media record.");
  return provider === "openai" ? analyzeWithOpenAI(mediaPath, taxonomy, signal) : analyzeWithPi(mediaPath, taxonomy, signal);
}

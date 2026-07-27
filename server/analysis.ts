import "dotenv/config";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { ZodError } from "zod";
import { analysisSchema, type Analysis, type CatalogItem, type Taxonomy } from "../shared/schema.js";
import { paths } from "./catalog.js";

export type AnalysisProvider = "opencode" | "openai";
export const OPENCODE_VISION_MODEL = "openai/gpt-5.6-luna";
const ANALYSIS_TIMEOUT_MS = 240_000;
const MAX_PROCESS_OUTPUT = 64 * 1024;

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

function appendOutput(current: string, chunk: Buffer) {
  const next = `${current}${chunk.toString()}`;
  return next.length > MAX_PROCESS_OUTPUT ? next.slice(-MAX_PROCESS_OUTPUT) : next;
}

function jsonFromText(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf("{");
    const last = candidate.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(candidate.slice(first, last + 1));
    throw new AnalysisError("invalid-output", "OpenCode returned an incomplete analysis. Try again.", "No JSON object was found in the final OpenCode response.");
  }
}

function collectText(value: unknown, target: string[]) {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectText(entry, target));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "text" && typeof entry === "string") target.push(entry);
    else collectText(entry, target);
  }
}

function errorTextFromEvent(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const event = value as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  if (!type.includes("error") && !event.error) return null;
  const candidates = [
    event.message,
    typeof event.error === "string" ? event.error : null,
    event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>).message : null,
    event.properties && typeof event.properties === "object" ? (event.properties as Record<string, unknown>).message : null,
    event.properties && typeof event.properties === "object" && (event.properties as Record<string, unknown>).error && typeof (event.properties as Record<string, unknown>).error === "object"
      ? ((event.properties as Record<string, unknown>).error as Record<string, unknown>).message
      : null,
  ];
  return compact(candidates.find((candidate): candidate is string => typeof candidate === "string") ?? "") || null;
}

export function parseOpenCodeEvents(output: string) {
  const messages: string[] = [];
  const errors: string[] = [];
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as unknown;
      const error = errorTextFromEvent(event);
      if (error) errors.push(error);
      collectText(event, messages);
    } catch {
      // A provider can emit ordinary text instead of NDJSON; try the full stream below.
    }
  }
  for (const message of messages.toReversed()) {
    try {
      return { value: jsonFromText(message), providerError: errors.at(-1) ?? null };
    } catch (error) {
      if (!(error instanceof AnalysisError)) throw error;
    }
  }
  if (errors.length) {
    throw new AnalysisError("provider", "OpenCode could not analyze this image.", errors.at(-1)!);
  }
  try {
    return { value: jsonFromText(output), providerError: errors.at(-1) ?? null };
  } catch (error) {
    if (errors.length) {
      throw new AnalysisError("provider", "OpenCode could not analyze this image.", errors.at(-1)!);
    }
    throw error;
  }
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

type CommandResult = { stdout: string; stderr: string; durationMs: number };

async function runOpenCodeCommand(mediaPath: string, prompt: string, signal?: AbortSignal): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise<CommandResult>((resolve, reject) => {
      const args = ["run", "--format", "json", "--agent", "catalog-vision", "--model", OPENCODE_VISION_MODEL, "--variant", "minimal", "--file", mediaPath, "--dir", paths.root, prompt];
      // This project agent has no tool permissions, so it can see the attached image
      // without reading, editing, or delegating work in the catalog repository.
      const child = spawn("opencode", args, { cwd: paths.root, env: process.env });
      // `opencode run` otherwise waits for this inherited pipe to close after replying.
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      let settled = false;
      let forceKill: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: CommandResult | AnalysisError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        signal?.removeEventListener("abort", cancel);
        if (result instanceof AnalysisError) reject(result);
        else resolve(result);
      };

      const stop = (error: AnalysisError) => {
        if (settled) return;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
        finish(error);
      };

      const cancel = () => stop(new AnalysisError("canceled", "Analysis canceled.", "The analysis request was canceled before OpenCode finished."));
      const timeout = setTimeout(() => stop(new AnalysisError("timeout", "Analysis timed out after four minutes. Try again.", `OpenCode did not finish within ${ANALYSIS_TIMEOUT_MS}ms.`)), ANALYSIS_TIMEOUT_MS);

      if (signal?.aborted) {
        cancel();
        return;
      }
      signal?.addEventListener("abort", cancel, { once: true });
      child.stdout.on("data", (data: Buffer) => (stdout = appendOutput(stdout, data)));
      child.stderr.on("data", (data: Buffer) => (stderr = appendOutput(stderr, data)));
      child.once("error", (error) => {
        const unavailable = (error as NodeJS.ErrnoException).code === "ENOENT";
        finish(new AnalysisError(
          unavailable ? "unavailable" : "provider",
          unavailable ? "OpenCode is not available on this machine." : "OpenCode could not start analysis.",
          compact(error.message),
        ));
      });
      child.once("close", (code, closeSignal) => {
        if (settled) return;
        if (code === 0) {
          finish({ stdout, stderr, durationMs: Date.now() - startedAt });
          return;
        }
        let eventError: string | null = null;
        try {
          eventError = parseOpenCodeEvents(stdout).providerError;
        } catch (error) {
          if (error instanceof AnalysisError && error.code === "provider") eventError = error.diagnostic;
        }
        finish(new AnalysisError(
          "provider",
          "OpenCode could not analyze this image.",
          eventError || compact(stderr) || compact(stdout) || `OpenCode exited with code ${code ?? "unknown"} (${closeSignal ?? "no signal"}).`,
        ));
      });
  });
}

async function validOpenCodeAnalysis(mediaPath: string, taxonomy: Taxonomy, prompt: string, signal?: AbortSignal) {
  const result = await runOpenCodeCommand(mediaPath, prompt, signal);
  try {
    return completeAnalysis(parseOpenCodeEvents(result.stdout).value, "opencode");
  } catch (error) {
    const issues = schemaIssues(error);
    if (issues) throw new AnalysisError("invalid-output", "OpenCode returned an incomplete analysis. Try again.", issues);
    throw error;
  }
}

async function analyzeWithOpenCode(mediaPath: string, taxonomy: Taxonomy, signal?: AbortSignal): Promise<Analysis> {
  try {
    return await validOpenCodeAnalysis(mediaPath, taxonomy, analysisPrompt(taxonomy), signal);
  } catch (error) {
    if (!(error instanceof AnalysisError) || error.code !== "invalid-output") throw error;
    try {
      return await validOpenCodeAnalysis(mediaPath, taxonomy, correctionPrompt(taxonomy, error.diagnostic), signal);
    } catch (retryError) {
      if (retryError instanceof AnalysisError) throw retryError;
      throw new AnalysisError("invalid-output", "OpenCode returned an incomplete analysis. Try again.", compact(String(retryError)));
    }
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
    return completeAnalysis(jsonFromText(content), "openai");
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
  return provider === "openai" ? analyzeWithOpenAI(mediaPath, taxonomy, signal) : analyzeWithOpenCode(mediaPath, taxonomy, signal);
}

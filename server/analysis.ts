import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analysisSchema, type Analysis, type CatalogItem, type Taxonomy } from "../shared/schema.js";

export type AnalysisProvider = "opencode" | "openai";

function analysisPrompt(taxonomy: Taxonomy) {
  const tags = taxonomy.groups.flatMap((group) => group.tags.map((tag) => `${tag.id} (${tag.label})`)).join(", ");
  return `Analyze this design inspiration image for a private design-reference catalog. Return ONLY one JSON object with this exact shape:
{
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
Rules: provide 3-6 palette colors when possible, never invent unreadable text, never use brand names/logos/copyrighted characters in heroPrompt, and describe the visual techniques and composition instead. Allowed tag IDs: ${tags}.`;
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
    throw new Error("The analysis provider did not return JSON.");
  }
}

function jsonFromOpenCodeEvents(output: string) {
  const messages: string[] = [];
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as unknown;
      collectText(event, messages);
    } catch {
      // The command may emit an ordinary text response when a provider changes output format.
    }
  }
  for (const message of messages.toReversed()) {
    try {
      return jsonFromText(message);
    } catch {
      // Streaming events may include partial message content before the final part.
    }
  }
  return jsonFromText(output);
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

function completeAnalysis(value: unknown, provider: AnalysisProvider): Analysis {
  const object = value as Record<string, unknown>;
  return analysisSchema.parse({
    ...object,
    version: 1,
    provider,
    analyzedAt: new Date().toISOString(),
  });
}

async function analyzeWithOpenCode(mediaPath: string, taxonomy: Taxonomy): Promise<Analysis> {
  const workdir = await mkdtemp(join(tmpdir(), "inspo-analysis-"));
  const args = ["run", "--format", "json", "--file", mediaPath, "--dir", workdir, analysisPrompt(taxonomy)];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("opencode", args, { cwd: workdir, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`OpenCode analysis failed${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
  return completeAnalysis(jsonFromOpenCodeEvents(output), "opencode");
}

async function analyzeWithOpenAI(mediaPath: string, taxonomy: Taxonomy): Promise<Analysis> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for the OpenAI analysis provider.");
  const image = await import("node:fs/promises").then(({ readFile }) => readFile(mediaPath));
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL ?? "gpt-4.1-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a precise design analyst. Reply with valid JSON only." },
        {
          role: "user",
          content: [
            { type: "text", text: analysisPrompt(taxonomy) },
            {
              type: "image_url",
              image_url: { url: `data:image/webp;base64,${image.toString("base64")}`, detail: "high" },
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI analysis failed (${response.status}): ${await response.text()}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no analysis content.");
  return completeAnalysis(jsonFromText(content), "openai");
}

export async function analyzeItem(item: CatalogItem, mediaPath: string, taxonomy: Taxonomy, provider: AnalysisProvider) {
  if (!item.media) throw new Error("This item needs an image before it can be analyzed.");
  return provider === "openai" ? analyzeWithOpenAI(mediaPath, taxonomy) : analyzeWithOpenCode(mediaPath, taxonomy);
}

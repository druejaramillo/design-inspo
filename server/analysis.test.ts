import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analysisProviderSchema, analysisSchema, type CatalogItem } from "../shared/schema.js";
import { AnalysisError, analysisErrorMessage, analysisStatusAfterError, analyzeItem, parsePiEvents } from "./analysis.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  access: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

const visualReading = {
  title: "Editorial citrus study",
  palette: [{ hex: "#112233", role: "background" }, { hex: "#EEDDCC", role: "text" }],
  style: ["editorial"],
  tone: ["warm"],
  layout: ["asymmetric"],
  typography: ["serif"],
  uiMotifs: ["thin rules"],
  notes: "A restrained editorial composition.",
  suggestedTagIds: ["editorial"],
  heroPrompt: null,
};

const item: CatalogItem = {
  id: "test-reference",
  title: "Original title",
  notes: "",
  sourceUrl: null,
  sourceDomain: null,
  captureMethod: "drop",
  importedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  media: { path: "catalog/media/test-reference.webp", width: 100, height: 100, format: "webp" },
  manualTagIds: [],
  analysis: null,
  analysisStatus: "pending",
  analysisError: null,
};
const taxonomy = { groups: [{ id: "style", label: "Style", tags: [{ id: "editorial", label: "Editorial" }] }] };
const mediaPath = "/tmp/field notes/test-reference.webp";

function assistantEvent(text: string, stopReason = "stop", errorMessage?: string) {
  return {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
  };
}

function eventStream(...events: unknown[]) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

function piProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}

function mockPiReply(output: string, code = 0, stderr = "") {
  const child = piProcess();
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.write(output);
      child.stderr.write(stderr);
      child.emit("close", code, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  return child;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PI_VISION_MODEL", "");
  vi.stubEnv("PI_VISION_EXTENSION", "");
  vi.stubEnv("PI_CODING_AGENT_DIR", "/tmp/pi-agent");
  vi.mocked(access).mockResolvedValue(undefined);
  vi.mocked(mkdir).mockResolvedValue(undefined);
  vi.mocked(mkdtemp).mockResolvedValue("/tmp/field-notes-pi-test");
  vi.mocked(rm).mockResolvedValue(undefined);
  vi.mocked(writeFile).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("Pi analysis events", () => {
  it("reads the final completed assistant JSON, not prompts, thinking, deltas, or tool results", () => {
    const output = eventStream(
      { type: "session", version: 3 },
      assistantEvent('{"title":"Earlier response"}'),
      { type: "message_end", message: { role: "user", content: '{"title":"Prompt"}' } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: '{"title":"Partial"}' } },
      { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: '{"title":"Tool output"}' }] } },
      { type: "message_end", message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: '{"title":"Reasoning"}' }, { type: "text", text: '{"title":' }, { type: "text", text: '"Editorial citrus study"}' }],
        stopReason: "stop",
      } },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled", aborted: false },
    );

    expect(parsePiEvents(output)).toEqual({ title: "Editorial citrus study" });
  });

  it("reads fenced JSON and tolerates non-event startup lines and CRLF", () => {
    const output = `Startup notice\r\n${JSON.stringify(assistantEvent('```json\n{"title":"Citrus"}\n```'))}\r\n`;
    expect(parsePiEvents(output)).toEqual({ title: "Citrus" });
  });

  it("keeps Unicode line separators inside JSON strings", () => {
    expect(parsePiEvents(eventStream(assistantEvent('{"title":"A\u2028B\u2029C"}')))).toEqual({ title: "A\u2028B\u2029C" });
  });

  it("uses a successful final response after Pi recovers from a provider error", () => {
    const output = eventStream(
      assistantEvent("", "error", "Temporary provider overload"),
      { type: "auto_retry_start", attempt: 1 },
      assistantEvent(JSON.stringify(visualReading)),
      { type: "auto_retry_end", success: true, attempt: 1 },
    );
    expect(parsePiEvents(output)).toEqual(visualReading);
  });

  it("exposes provider errors even when the Pi process exits successfully", () => {
    const output = eventStream(assistantEvent("", "error", "No provider credentials configured"));
    expect(() => parsePiEvents(output)).toThrowError(expect.objectContaining({
      code: "provider",
      diagnostic: "No provider credentials configured",
    }));
  });

  it("reports exhausted provider retries", () => {
    const output = eventStream({ type: "auto_retry_end", success: false, finalError: "Provider unavailable" });
    expect(() => parsePiEvents(output)).toThrowError(expect.objectContaining({ code: "provider", diagnostic: "Provider unavailable" }));
  });

  it.each(["aborted", "settled"])("keeps %s cancellation distinct from failure", (kind) => {
    const output = kind === "aborted"
      ? eventStream(assistantEvent("", "aborted"))
      : eventStream(assistantEvent(JSON.stringify(visualReading)), { type: "agent_settled", aborted: true });
    expect(() => parsePiEvents(output)).toThrowError(expect.objectContaining({ code: "canceled" }));
  });

  it.each(["length", "toolUse", "pending", "deferred"])("rejects a %s response even if its text is valid JSON", (stopReason) => {
    expect(() => parsePiEvents(eventStream(assistantEvent(JSON.stringify(visualReading), stopReason))))
      .toThrowError(expect.objectContaining({ code: "invalid-output" }));
  });

  it.each(["", "not JSON", '{"title":broken}'])("normalizes invalid response text %j for a correction retry", (text) => {
    expect(() => parsePiEvents(eventStream(assistantEvent(text))))
      .toThrowError(expect.objectContaining({ code: "invalid-output" }));
  });

  it("does not fall back to an earlier valid response when the final response is invalid", () => {
    const output = eventStream(assistantEvent(JSON.stringify(visualReading)), assistantEvent("incomplete"));
    expect(() => parsePiEvents(output)).toThrowError(expect.objectContaining({ code: "invalid-output" }));
  });

  it("requires a completed assistant message instead of accepting a raw JSON result", () => {
    expect(() => parsePiEvents(JSON.stringify(visualReading))).toThrowError(expect.objectContaining({ code: "invalid-output" }));
  });
});

describe("Pi analysis engine", () => {
  it("uses GPT-6 Luna, high thinking, and only the Better OpenAI extension with tools disabled", async () => {
    const child = mockPiReply(eventStream(assistantEvent(JSON.stringify(visualReading))));
    const analysis = await analyzeItem(item, mediaPath, taxonomy, "pi");

    expect(analysis).toMatchObject({ ...visualReading, provider: "pi", version: 1 });
    expect(analysis.analyzedAt).toEqual(expect.any(String));
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(command).toBe("pi");
    expect(args).toEqual(expect.arrayContaining([
      "--print", "--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-mcp",
      "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--system-prompt",
    ]));
    expect(args?.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "openai-codex/gpt-6-luna"]);
    expect(args?.slice(args.indexOf("--thinking"), args.indexOf("--thinking") + 2)).toEqual(["--thinking", "high"]);
    expect(args?.slice(args.indexOf("--extension"), args.indexOf("--extension") + 2)).toEqual(["--extension", "/tmp/pi-agent/npm/node_modules/@monotykamary/pi-better-openai/index.ts"]);
    expect(args?.filter((arg) => arg === "--extension")).toHaveLength(1);
    expect(args).not.toContain("--fast");
    expect(args?.slice(-3)).toEqual(["--", `@${mediaPath}`, expect.stringContaining("editorial (Editorial)")]);
    expect(options).toMatchObject({ cwd: "/tmp/field-notes-pi-test" });
    expect(child.stdin.writableEnded).toBe(true);
    expect(rm).toHaveBeenCalledWith("/tmp/field-notes-pi-test", { recursive: true, force: true });
  });

  it("keeps the final result when later bookkeeping events contain large reasoning blocks", async () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "x".repeat(70_000) }, { type: "text", text: JSON.stringify(visualReading) }],
      stopReason: "stop",
    };
    mockPiReply(eventStream(
      { type: "message_end", message },
      { type: "turn_end", message, toolResults: [] },
      { type: "agent_end", messages: [message], willRetry: false },
      { type: "agent_settled", aborted: false },
    ));
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi")).resolves.toMatchObject({ title: visualReading.title });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("preserves multibyte text split across process output chunks", async () => {
    const child = piProcess();
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => {
        const output = Buffer.from(eventStream(assistantEvent(JSON.stringify({ ...visualReading, title: "Café study" }))));
        const split = output.indexOf(Buffer.from("é")) + 1;
        child.stdout.write(output.subarray(0, split));
        child.stdout.write(output.subarray(split));
        child.emit("close", 0, null);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi")).resolves.toMatchObject({ title: "Café study" });
  });

  it("configures Fast mode without enabling background services or optional tools", async () => {
    mockPiReply(eventStream(assistantEvent(JSON.stringify(visualReading))));
    await analyzeItem(item, mediaPath, taxonomy, "pi");
    const [configPath, config] = vi.mocked(writeFile).mock.calls[0];
    expect(configPath).toBe("/tmp/field-notes-pi-test/.pi/extensions/pi-better-openai.json");
    expect(JSON.parse(String(config))).toMatchObject({
      serviceTier: "fast",
      persistState: true,
      supportedModels: ["openai-codex/gpt-6-luna"],
      usage: { enabled: false, autoRedeemBankedResets: false },
      image: { enabled: false },
      websearch: { enabled: false },
      decisions: { enabled: false },
      live: { enabled: false },
      pets: { enabled: false },
    });
  });

  it("uses an explicitly configured local Better OpenAI extension", async () => {
    vi.stubEnv("PI_VISION_EXTENSION", "/tmp/custom-better-openai/index.ts");
    mockPiReply(eventStream(assistantEvent(JSON.stringify(visualReading))));
    await analyzeItem(item, mediaPath, taxonomy, "pi");
    const args = vi.mocked(spawn).mock.calls[0][1]!;
    expect(args.slice(args.indexOf("--extension"), args.indexOf("--extension") + 2)).toEqual(["--extension", "/tmp/custom-better-openai/index.ts"]);
  });

  it("fails before launching Pi if the Fast mode extension is missing", async () => {
    vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error("Extension not found"), { code: "ENOENT" }));
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("pi-better-openai") });
    expect(spawn).not.toHaveBeenCalled();
    expect(mkdtemp).not.toHaveBeenCalled();
  });

  it("rejects model overrides that cannot use OpenAI Fast mode", async () => {
    vi.stubEnv("PI_VISION_MODEL", "another-provider/vision-model");
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi")).rejects.toMatchObject({ code: "unavailable" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("removes the temporary config if preparation fails", async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("Cannot write analysis config"));
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi")).rejects.toThrow("Cannot write analysis config");
    expect(rm).toHaveBeenCalledWith("/tmp/field-notes-pi-test", { recursive: true, force: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not launch Pi if the request is canceled during preparation", async () => {
    const controller = new AbortController();
    vi.mocked(writeFile).mockImplementationOnce(async () => { controller.abort(); });
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi", controller.signal)).rejects.toMatchObject({ code: "canceled" });
    expect(rm).toHaveBeenCalledWith("/tmp/field-notes-pi-test", { recursive: true, force: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes an explicit compatible Pi model override as one argument", async () => {
    vi.stubEnv("PI_VISION_MODEL", "openai-codex/vision-model");
    mockPiReply(eventStream(assistantEvent(JSON.stringify(visualReading))));
    await analyzeItem(item, mediaPath, taxonomy, "pi");
    const args = vi.mocked(spawn).mock.calls[0][1]!;
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "openai-codex/vision-model"]);
  });

  it.each(["not JSON", '{"title":broken}', '{"title":"Missing fields"}'])("retries invalid analysis %j once with correction guidance", async (invalid) => {
    mockPiReply(eventStream(assistantEvent(invalid)));
    mockPiReply(eventStream(assistantEvent(JSON.stringify(visualReading))));
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi")).resolves.toMatchObject({ provider: "pi", title: visualReading.title });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls[1][1]?.at(-1)).toContain("Your previous response did not match the required JSON shape");
  });

  it("stops after one correction retry", async () => {
    mockPiReply(eventStream(assistantEvent("invalid")));
    mockPiReply(eventStream(assistantEvent("invalid again")));
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi")).rejects.toMatchObject({ code: "invalid-output" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not retry provider failures from a zero exit status", async () => {
    mockPiReply(eventStream(assistantEvent("", "error", "Sign in to Pi")));
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi")).rejects.toMatchObject({ code: "provider", diagnostic: "Sign in to Pi" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports process failures from stderr", async () => {
    mockPiReply("", 1, "No image-capable model available");
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi")).rejects.toMatchObject({ code: "provider", diagnostic: "No image-capable model available" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports a missing Pi executable without retrying", async () => {
    const child = piProcess();
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" })));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("Pi is not available") });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not start a process for an already canceled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(analyzeItem(item, mediaPath, taxonomy, "pi", controller.signal)).rejects.toMatchObject({ code: "canceled" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("terminates a canceled process and forces it to stop if SIGTERM is ignored", async () => {
    vi.useFakeTimers();
    const child = piProcess();
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
    const controller = new AbortController();
    const result = analyzeItem(item, mediaPath, taxonomy, "pi", controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ code: "canceled" });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", null, "SIGKILL");
  });

  it("clears the force-stop timer after the canceled process exits", async () => {
    vi.useFakeTimers();
    const child = piProcess();
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
    const controller = new AbortController();
    const result = analyzeItem(item, mediaPath, taxonomy, "pi", controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ code: "canceled" });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    controller.abort();
    child.emit("close", null, "SIGTERM");
    await rejected;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("times out after four minutes and stops the Pi process", async () => {
    vi.useFakeTimers();
    const child = piProcess();
    vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
    const result = analyzeItem(item, mediaPath, taxonomy, "pi");
    const rejected = expect(result).rejects.toMatchObject({ code: "timeout" });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(240_000);
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects an item without an image before invoking Pi", async () => {
    await expect(analyzeItem({ ...item, media: null }, mediaPath, taxonomy, "pi")).rejects.toMatchObject({ code: "invalid-output" });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("analysis provider compatibility", () => {
  it("accepts Pi and direct OpenAI requests, but not the retired engine", () => {
    expect(analysisProviderSchema.parse("pi")).toBe("pi");
    expect(analysisProviderSchema.parse("openai")).toBe("openai");
    expect(analysisProviderSchema.safeParse("opencode").success).toBe(false);
  });

  it("preserves the provider on saved OpenCode results", () => {
    const saved = { ...visualReading, version: 1, provider: "opencode", analyzedAt: "2026-01-01T00:00:00.000Z" };
    expect(analysisSchema.parse(saved)).toEqual(saved);
  });

  it("keeps cancellation distinct from a failed analysis", () => {
    const error = new AnalysisError("canceled", "Analysis canceled.", "Request aborted by user.");
    expect(analysisErrorMessage(error)).toBe("Analysis canceled.");
    expect(analysisStatusAfterError(error)).toBe("canceled");
  });
});

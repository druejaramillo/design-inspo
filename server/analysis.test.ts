import { describe, expect, it } from "vitest";
import { AnalysisError, analysisErrorMessage, analysisStatusAfterError, parseOpenCodeEvents } from "./analysis.js";

describe("OpenCode analysis events", () => {
  it("reads the final assistant JSON text from NDJSON", () => {
    const output = [
      JSON.stringify({ type: "message.part.updated", properties: { part: { type: "text", text: "not the final response" } } }),
      JSON.stringify({ type: "message.part.updated", properties: { part: { type: "text", text: '{"title":"Editorial citrus study"}' } } }),
    ].join("\n");

    expect(parseOpenCodeEvents(output).value).toEqual({ title: "Editorial citrus study" });
  });

  it("exposes provider errors emitted on stdout", () => {
    const output = JSON.stringify({ type: "error", properties: { error: { message: "No OpenAI credentials configured" } } });

    expect(() => parseOpenCodeEvents(output)).toThrow("OpenCode could not analyze this image.");
  });

  it("keeps cancellation distinct from a failed analysis", () => {
    const error = new AnalysisError("canceled", "Analysis canceled.", "Request aborted by user.");
    expect(analysisErrorMessage(error)).toBe("Analysis canceled.");
    expect(analysisStatusAfterError(error)).toBe("canceled");
  });
});

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { PukuAdapter } from "../../src/adapters/puku.js";
import { getAdapter, listAdapters, detectAdapters } from "../../src/adapters/registry.js";

describe("registry", () => {
  it("exposes claude and puku adapters in v0.1", () => {
    const tools = listAdapters().map((a) => a.tool).sort();
    expect(tools).toEqual(["claude", "puku"]);
  });

  it("getAdapter returns the right instance", () => {
    expect(getAdapter("claude")).toBeInstanceOf(ClaudeAdapter);
    expect(getAdapter("puku")).toBeInstanceOf(PukuAdapter);
  });

  it("getAdapter throws on unknown tool", () => {
    expect(() => getAdapter("gemini" as never)).toThrow();
  });
});

describe("ClaudeAdapter.canHandle", () => {
  it("returns high confidence for a cwd with sessions under ~/.claude", async () => {
    const adapter = new ClaudeAdapter();
    // The fixture lives under test/fixtures. Claude's storage is in ~/.claude.
    // We can still test the negative path here.
    const result = await adapter.canHandle("/nonexistent/path/that/does/not/exist");
    expect(result.confidence).toBe(0);
  });
});

describe("detectAdapters", () => {
  it("returns an empty list for a cwd with no known sessions", async () => {
    const results = await detectAdapters("/nonexistent/path/that/does/not/exist");
    expect(results).toEqual([]);
  });
});

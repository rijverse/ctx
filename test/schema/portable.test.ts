import { describe, it, expect } from "vitest";
import {
  PortableSession,
  ContentBlockSchema,
  makePortableSession,
} from "../../src/schema/portable.js";
import { SCHEMA_VERSION } from "../../src/schema/version.js";

describe("PortableSession schema", () => {
  it("accepts a valid minimal session", () => {
    const session = makePortableSession({
      source: { tool: "claude" },
      session: { id: "abc", cwd: "/tmp" },
      messages: [],
    });
    expect(session.schema_version).toBe("1.0");
    expect(session.source.tool).toBe("claude");
    expect(typeof session.source.exported_at).toBe("string");
  });

  it("rejects an unknown source tool", () => {
    expect(() =>
      PortableSession.parse({
        schema_version: "1.0",
        source: { tool: "bogus", exported_at: new Date().toISOString() },
        session: { id: "x", cwd: "/tmp" },
        messages: [],
      })
    ).toThrow();
  });

  it("rejects an unknown schema version", () => {
    expect(() =>
      PortableSession.parse({
        schema_version: "0.9",
        source: { tool: "claude", exported_at: new Date().toISOString() },
        session: { id: "x", cwd: "/tmp" },
        messages: [],
      })
    ).toThrow();
  });

  it("accepts all content block types", () => {
    const blocks = [
      { type: "text", text: "hi" },
      { type: "thinking", thinking: "reasoning" },
      { type: "redacted_thinking", reason: "encrypted" },
      { type: "tool_use", id: "t1", name: "Read", input: {} },
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "ok",
        is_error: false,
      },
    ] as const;
    for (const b of blocks) {
      expect(() => ContentBlockSchema.parse(b)).not.toThrow();
    }
  });

  it("exposes a stable schema version constant", () => {
    expect(SCHEMA_VERSION).toBe("1.0");
  });
});

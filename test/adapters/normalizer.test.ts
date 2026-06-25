import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { normalizeClaudeEvents, type ClaudeEvent } from "../../src/normalizers/claude-jsonl.js";

const FIXTURE = resolve(__dirname, "../fixtures/claude/small-session.jsonl");

function loadEvents(): ClaudeEvent[] {
  const raw = readFileSync(FIXTURE, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ClaudeEvent);
}

describe("normalizeClaudeEvents", () => {
  it("returns a session with messages and metadata", () => {
    const events = loadEvents();
    const session = normalizeClaudeEvents(events);

    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.cwd).toMatch(/^\/home\/test\/project/);
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("drops control events (mode, permission-mode, file-history-snapshot)", () => {
    const events = loadEvents();
    const session = normalizeClaudeEvents(events);

    // Control events should not appear as messages
    for (const msg of session.messages) {
      expect(["user", "assistant", "system"]).toContain(msg.role);
    }
  });

  it("preserves message order via parentUuid walk", () => {
    const events = loadEvents();
    const session = normalizeClaudeEvents(events);

    // Timestamps should be non-decreasing
    let lastTs = 0;
    for (const msg of session.messages) {
      if (msg.timestamp) {
        const ts = Date.parse(msg.timestamp);
        expect(ts).toBeGreaterThanOrEqual(lastTs);
        lastTs = ts;
      }
    }
  });

  it("redacts encrypted thinking blocks", () => {
    // Inject a redacted_thinking event
    const events: ClaudeEvent[] = [
      {
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        sessionId: "s1",
        message: { role: "user", content: "Hello" },
      },
      {
        type: "assistant",
        uuid: "u2",
        parentUuid: "u1",
        timestamp: "2026-01-01T00:00:01.000Z",
        sessionId: "s1",
        message: {
          role: "assistant",
          content: [
            { type: "redacted_thinking", data: "encrypted" },
            { type: "text", text: "Hi there" },
          ],
        },
      },
    ];
    const session = normalizeClaudeEvents(events);
    const assistant = session.messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    if (Array.isArray(assistant!.content)) {
      const redacted = assistant!.content.find((b) => b.type === "redacted_thinking");
      expect(redacted).toBeDefined();
    }
  });
});

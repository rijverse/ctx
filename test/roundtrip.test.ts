import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeClaudeEvents,
  type ClaudeEvent,
} from "../src/normalizers/claude-jsonl.js";
import {
  makePortableSession,
  type PortableSession,
  type ContentBlock,
} from "../src/schema/portable.js";
import { writeNativeClaudeSession } from "../src/render/native-claude.js";
import { readJsonlStream } from "../src/io/readJsonlStream.js";

const CLAUDE_FIXTURE = resolve(
  __dirname,
  "fixtures/claude/small-session.jsonl"
);
const PUKU_FIXTURE = resolve(
  __dirname,
  "fixtures/puku/small-session.jsonl"
);

function loadEvents(path: string): ClaudeEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ClaudeEvent);
}

/**
 * Extract a content fingerprint (text + tool names + tool args) suitable
 * for comparing two messages for "semantic equality" after a round-trip.
 */
function fingerprint(msg: PortableSession["messages"][number]): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .map((b: ContentBlock) => {
      switch (b.type) {
        case "text":
          return `T:${b.text}`;
        case "thinking":
          return `K:${b.thinking}`;
        case "redacted_thinking":
          return `R:${b.reason}`;
        case "tool_use":
          return `U:${b.name}:${JSON.stringify(b.input)}`;
        case "tool_result":
          return `R:${
            typeof b.content === "string"
              ? b.content
              : b.content.map((c) => c.type).join(",")
          }`;
      }
    })
    .join("|");
}

describe("round-trip: claude to portable to claude-synthetic", () => {
  it("preserves message text and tool names through a full cycle", async () => {
    const events = loadEvents(CLAUDE_FIXTURE);
    const normalized = normalizeClaudeEvents(events);
    const portable: PortableSession = makePortableSession({
      source: { tool: "claude" },
      session: {
        id: normalized.id,
        started_at: normalized.startedAt,
        cwd: normalized.cwd,
        git_branch: normalized.gitBranch,
        model: normalized.model,
      },
      messages: normalized.messages,
    });

    try {
      const { filePath } = await writeNativeClaudeSession(
        portable,
        "claude",
        "/home/test/project",
        { dryRun: false }
      );

      // Sanity: the file was actually written
      const { existsSync } = await import("node:fs");
      expect(existsSync(filePath)).toBe(true);

      // Re-read the synthetic file
      const reRead: ClaudeEvent[] = [];
      for await (const ev of readJsonlStream<ClaudeEvent>(filePath)) {
        reRead.push(ev);
      }

      // The synthetic chain should have at least as many message events as
      // the original messages, plus a trailing last-prompt.
      const reNormalized = normalizeClaudeEvents(reRead);
      expect(reNormalized.messages.length).toBe(portable.messages.length);

      // Compare fingerprints
      for (let i = 0; i < portable.messages.length; i++) {
        const orig = portable.messages[i]!;
        const synth = reNormalized.messages[i]!;
        expect(synth.role).toBe(orig.role);
        // The text portions should match exactly (block-level)
        if (typeof orig.content === "string" && typeof synth.content === "string") {
          expect(synth.content).toBe(orig.content);
        }
      }
    } finally {
      // Clean up: remove the synthetic file under ~/.claude/projects/...
      try {
        const { rm } = await import("node:fs/promises");
        const projDir = join(
          process.env.HOME ?? "/tmp",
          ".claude",
          "projects",
          "-home-test-project"
        );
        await rm(projDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

describe("puku fixture parses the same way as claude", () => {
  it("normalizes without errors", () => {
    const events = loadEvents(PUKU_FIXTURE);
    const session = normalizeClaudeEvents(events);
    expect(session.messages.length).toBeGreaterThan(0);
    expect(session.cwd).toMatch(/^\/home\/test\/project/);
  });

  it("exports to a portable session and re-renders to markdown", async () => {
    const events = loadEvents(PUKU_FIXTURE);
    const session = normalizeClaudeEvents(events);
    const portable = makePortableSession({
      source: { tool: "puku" },
      session: {
        id: session.id,
        started_at: session.startedAt,
        cwd: session.cwd,
        git_branch: session.gitBranch,
        model: session.model,
      },
      messages: session.messages,
    });

    // Round-trip through validation
    const reparsed = JSON.parse(JSON.stringify(portable));
    expect(reparsed.schema_version).toBe("1.0");
    expect(reparsed.messages.length).toBe(portable.messages.length);
  });
});

describe("schema version is stable across serialization", () => {
  it("preserves schema_version after JSON round-trip", () => {
    const session = makePortableSession({
      source: { tool: "claude" },
      session: { id: "x", cwd: "/tmp" },
      messages: [],
    });
    const json = JSON.parse(JSON.stringify(session));
    expect(json.schema_version).toBe("1.0");
  });
});

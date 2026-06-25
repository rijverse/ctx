/**
 * Sanitize a real Claude/puku JSONL session into a fixture for testing.
 *
 * Strips:
 *   - tool_result content bodies (replaced with "[sanitized]")
 *   - text content beyond the first 200 chars
 *   - real uuids (replaced with deterministic fake uuids derived from index)
 *   - real file paths (replaced with /home/test/project/<basename>)
 *
 * Preserves structure, message ordering, tool names, tool_use IDs, and
 * block types. Enough to test the normalizer and renderer end-to-end.
 *
 * Also rebuilds the parentUuid chain linearly (each event points to the
 * previous one) so the normalizer's tree-walk has something to walk.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

function fakeUuid(i: number): string {
  return `${i.toString(16).padStart(8, "0")}-0000-4000-8000-${i
    .toString(16)
    .padStart(12, "0")}`;
}

function sanitizeBlock(block: unknown): unknown {
  if (!block || typeof block !== "object") return block;
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case "text":
      return {
        type: "text",
        text:
          typeof b.text === "string"
            ? b.text.length > 200
              ? b.text.slice(0, 200) + "..."
              : b.text
            : b.text,
      };
    case "thinking":
      return { type: "thinking", thinking: "[sanitized thinking]" };
    case "redacted_thinking":
      return { type: "redacted_thinking", reason: "encrypted" };
    case "tool_use":
      return {
        type: "tool_use",
        id: typeof b.id === "string" ? b.id : "toolu_unknown",
        name: b.name ?? "Unknown",
        input: "[sanitized input]",
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: "[sanitized output]",
        is_error: b.is_error ?? false,
      };
    default:
      return b;
  }
}

function sanitizePath(p: unknown): unknown {
  if (typeof p !== "string") return p;
  // Map any path under /home/<anything> to /home/test/project. This
  // preserves distinct directory names (e.g. www/context) as test
  // fixtures while keeping the canonical prefix.
  if (p.startsWith("/home/")) {
    const rest = p.slice("/home/".length);
    const parts = rest.split("/").slice(1); // drop the username
    return ["/home/test/project", ...parts].join("/");
  }
  return p;
}

function main(src: string, dst: string, limit: number): void {
  const raw = readFileSync(src, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const sanitized: string[] = [];
  let prevUuid: string | null = null;
  let counter = 0;
  let lastUuid: string | null = null;
  let sessionId = fakeUuid(9999);

  for (const line of lines.slice(0, limit)) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }

    const myUuid = fakeUuid(counter++);
    if (typeof ev.uuid === "string") ev.uuid = myUuid;
    // Linearize the chain: each event points to the previous one.
    ev.parentUuid = prevUuid;
    if (typeof ev.sessionId === "string") {
      ev.sessionId = sessionId;
    }
    if (typeof ev.cwd === "string") ev.cwd = sanitizePath(ev.cwd);
    if (typeof ev.leafUuid === "string") {
      // Don't rewrite leafUuid yet. Set it after we know the last user/assistant.
    }

    if (ev.message && typeof ev.message === "object") {
      const msg = ev.message as Record<string, unknown>;
      if ("content" in msg && msg.content !== undefined) {
        if (typeof msg.content === "string") {
          msg.content =
            msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content;
        } else if (Array.isArray(msg.content)) {
          msg.content = msg.content.map(sanitizeBlock);
        }
      }
    }

    if (ev.type === "user" || ev.type === "assistant") {
      lastUuid = myUuid;
    }

    sanitized.push(JSON.stringify(ev));
    prevUuid = myUuid;
  }

  // Append a synthetic last-prompt pointing at the last user/assistant
  if (lastUuid) {
    sanitized.push(
      JSON.stringify({
        parentUuid: prevUuid,
        isSidechain: false,
        type: "last-prompt",
        uuid: fakeUuid(counter++),
        timestamp: new Date().toISOString(),
        sessionId,
        cwd: "/home/test/project",
        gitBranch: "main",
        userType: "external",
        entrypoint: "cli",
        leafUuid: lastUuid,
      })
    );
  }

  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, sanitized.join("\n") + "\n", "utf8");
  console.log(`Wrote ${sanitized.length} sanitized events to ${dst}`);
}

const [, , src, dst, limitArg] = process.argv;
if (!src || !dst) {
  console.error("Usage: tsx test/sanitize-fixture.ts <src> <dst> [limit]");
  process.exit(1);
}
const limit = limitArg ? parseInt(limitArg, 10) : 100;
main(src, dst, limit);
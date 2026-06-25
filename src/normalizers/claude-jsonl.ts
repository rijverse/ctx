import { randomUUID, createHash } from "node:crypto";
import type { ContentBlock, PortableMessage } from "../schema/portable.js";

/**
 * Raw event shape from Claude Code / puku-cli JSONL. Both CLIs share this
 * schema (verified against real session files).
 */
export interface ClaudeEvent {
  parentUuid: string | null;
  isSidechain?: boolean;
  type:
    | "user"
    | "assistant"
    | "system"
    | "file-history-snapshot"
    | "last-prompt"
    | "mode"
    | "permission-mode"
    | "attachment"
    | "ai-title";
  message?: ClaudeMessage;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  userType?: string;
  entrypoint?: string;
  promptId?: string;
  isMeta?: boolean;
  requestId?: string;
  toolUseResult?: unknown;
  // Only present on "last-prompt" events:
  leafUuid?: string;
}

export interface ClaudeMessage {
  id?: string;
  role?: "user" | "assistant" | "system";
  model?: string;
  content: string | ClaudeBlock[];
  stop_reason?: string;
  usage?: Record<string, number>;
  service_tier?: string;
}

export type ClaudeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data?: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input?: unknown;
      caller?: unknown;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ClaudeBlock[];
      is_error?: boolean;
    };

export interface NormalizedSession {
  id: string;
  startedAt?: string;
  cwd: string;
  gitBranch?: string;
  model?: string;
  version?: string;
  messages: PortableMessage[];
}

/**
 * Reconstruct a Claude/puku conversation as a chronological list of
 * PortableMessages.
 *
 * Steps:
 *   1. Index events by uuid, also tracking the last user/assistant uuid
 *      and the last-prompt event's leafUuid (single pass).
 *   2. Pick a leaf: last-prompt's leafUuid, else most-recent user/assistant,
 *      else the first event.
 *   3. Walk parentUuid back from the leaf to the root.
 *   4. Reverse the chain so the result is chronological.
 *   5. Drop control events (mode, permission-mode, etc.) and convert each
 *      remaining message's content into PortableMessage form.
 */
export function normalizeClaudeEvents(events: ClaudeEvent[]): NormalizedSession {
  if (events.length === 0) {
    return {
      id: randomUUID(),
      cwd: "",
      messages: [],
    };
  }

  const byUuid = new Map<string, ClaudeEvent>();
  let lastLeafUuid: string | undefined;
  let fallbackLeafUuid: string | undefined;
  for (const ev of events) {
    if (ev.uuid) byUuid.set(ev.uuid, ev);
    if (ev.type === "last-prompt" && ev.leafUuid && !lastLeafUuid) {
      lastLeafUuid = ev.leafUuid;
    }
    if ((ev.type === "user" || ev.type === "assistant") && ev.uuid) {
      fallbackLeafUuid = ev.uuid;
    }
  }

  let leaf: ClaudeEvent | undefined;
  if (lastLeafUuid && byUuid.has(lastLeafUuid)) {
    leaf = byUuid.get(lastLeafUuid);
  } else if (fallbackLeafUuid && byUuid.has(fallbackLeafUuid)) {
    leaf = byUuid.get(fallbackLeafUuid);
  } else {
    leaf = events[0];
  }

  // Walk parentUuid chain from leaf to root
  const chain: ClaudeEvent[] = [];
  const visited = new Set<string>();
  let cursor: ClaudeEvent | undefined = leaf;
  while (cursor) {
    if (cursor.uuid && visited.has(cursor.uuid)) break; // cycle guard
    if (cursor.uuid) visited.add(cursor.uuid);
    chain.push(cursor);
    if (!cursor.parentUuid) break;
    cursor = byUuid.get(cursor.parentUuid);
  }
  chain.reverse();

  const messages: PortableMessage[] = [];
  let startedAt: string | undefined;
  let cwd = "";
  let gitBranch: string | undefined;
  let model: string | undefined;
  let version: string | undefined;
  let sessionId: string | undefined;

  for (const ev of chain) {
    if (ev.cwd) cwd = ev.cwd;
    if (ev.gitBranch) gitBranch = ev.gitBranch;
    if (ev.sessionId && !sessionId) sessionId = ev.sessionId;
    if (ev.version) version = ev.version;
    if (ev.timestamp && !startedAt) startedAt = ev.timestamp;

    if (ev.type !== "user" && ev.type !== "assistant" && ev.type !== "system") {
      continue;
    }
    if (!ev.message) continue;
    if (ev.isMeta) continue; // injected slash-command output and local caveats

    const msg = ev.message;
    const role = msg.role ?? ev.type;

    if (msg.model && !model) model = msg.model;

    const portable = convertMessage(
      role,
      msg.content,
      msg.model,
      msg.usage,
      ev.timestamp,
      ev.uuid
    );
    messages.push(portable);
  }

  return {
    id: sessionId ?? deriveSessionId(events),
    startedAt,
    cwd,
    gitBranch,
    model,
    version,
    messages,
  };
}

function convertMessage(
  role: "user" | "assistant" | "system",
  content: string | ClaudeBlock[],
  model?: string,
  usage?: Record<string, number>,
  timestamp?: string,
  uuid?: string
): PortableMessage {
  if (typeof content === "string") {
    return {
      role,
      content,
      model,
      usage,
      timestamp,
      uuid,
    };
  }

  const blocks: ContentBlock[] = content.map(mapBlock);
  return {
    role,
    content: blocks,
    model,
    usage,
    timestamp,
    uuid,
  };
}

function mapBlock(b: ClaudeBlock): ContentBlock {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      return { type: "thinking", thinking: b.thinking };
    case "redacted_thinking":
      return { type: "redacted_thinking", reason: "encrypted" };
    case "tool_use":
      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: b.input,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.tool_use_id,
        content: typeof b.content === "string" ? b.content : b.content.map(mapBlock),
        is_error: b.is_error ?? false,
      };
  }
}

/**
 * Synthesize a session id when events don't carry one. Deterministic from
 * the event uuids so the same source always yields the same id.
 */
function deriveSessionId(events: ClaudeEvent[]): string {
  const seed = events
    .filter((e) => e.uuid)
    .map((e) => e.uuid)
    .join("|");
  return createHash("sha256").update(seed || Date.now().toString()).digest("hex");
}
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { projectsDir, toolRoot } from "../io/paths.js";
import { NATIVE_CAPABLE, type ContentBlock, type PortableSession, type ToolName } from "../schema/portable.js";

interface NativeWriteResult {
  filePath: string;
}

/**
 * Convert a PortableSession into a synthetic Claude/puku JSONL file at the
 * target cwd. The output mimics the on-disk schema closely enough that
 * both CLIs will treat it as a fresh session and append to it.
 *
 * Caveats (also documented in --help):
 *   - The synthetic chain uses a fresh `last-prompt` event whose `leafUuid`
 *     is the final user message, so the CLI's reconstructor follows the
 *     chain correctly.
 *   - UUIDs are generated fresh. They are not the originals from the source.
 *   - The `parentUuid` chain is rebuilt from scratch in conversation order.
 */
export async function writeNativeClaudeSession(
  session: PortableSession,
  targetTool: ToolName,
  targetCwd: string,
  opts: { dryRun: boolean }
): Promise<NativeWriteResult> {
  if (!NATIVE_CAPABLE.has(targetTool)) {
    throw new Error(
      `--write-native is only supported for "claude" and "puku" (got "${targetTool}")`
    );
  }

  const root = toolRoot(targetTool);
  const newSessionId = randomUUID();
  const filePath = join(projectsDir(root, targetCwd), `${newSessionId}.jsonl`);

  if (opts.dryRun) {
    return { filePath };
  }

  const events = buildSyntheticEvents(session, targetCwd, newSessionId);
  const jsonl = events.map((e) => JSON.stringify(e)).join("\n") + "\n";

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, jsonl, "utf8");
  return { filePath };
}

interface SyntheticEvent {
  parentUuid: string | null;
  isSidechain: boolean;
  type: string;
  uuid: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  version?: string;
  gitBranch?: string;
  userType: string;
  entrypoint: string;
  message?: {
    id?: string;
    role: "user" | "assistant" | "system";
    model?: string;
    content: string | ContentBlock[];
  };
  leafUuid?: string;
  isMeta?: boolean;
}

function buildSyntheticEvents(
  session: PortableSession,
  targetCwd: string,
  newSessionId: string
): SyntheticEvent[] {
  const events: SyntheticEvent[] = [];
  const baseTs = Date.parse(session.session.started_at ?? new Date().toISOString());

  let prevUuid: string | null = null;
  const messageUuids: string[] = [];

  session.messages.forEach((msg, i) => {
    const uuid = randomUUID();
    messageUuids.push(uuid);

    const ts = new Date(baseTs + i).toISOString();
    const ev: SyntheticEvent = {
      parentUuid: prevUuid,
      isSidechain: false,
      type: msg.role,
      uuid,
      timestamp: ts,
      sessionId: newSessionId,
      cwd: targetCwd,
      gitBranch: session.session.git_branch,
      userType: "external",
      entrypoint: "cli",
      message: {
        id: msg.uuid ?? `msg_${randomUUID().slice(0, 8)}`,
        role: msg.role,
        model: msg.model,
        content: msg.content,
      },
    };
    events.push(ev);
    prevUuid = uuid;
  });

  // Add a synthetic last-prompt event pointing at the final user message.
  // Claude's reconstructor uses this to find the leaf.
  const lastUserIdx = findLastUserIndex(session);
  const leafIdx = lastUserIdx >= 0 ? lastUserIdx : session.messages.length - 1;
  const leafUuid = messageUuids[leafIdx] ?? prevUuid ?? randomUUID();

  if (prevUuid) {
    events.push({
      parentUuid: prevUuid,
      isSidechain: false,
      type: "last-prompt",
      uuid: randomUUID(),
      timestamp: new Date(baseTs + session.messages.length).toISOString(),
      sessionId: newSessionId,
      cwd: targetCwd,
      gitBranch: session.session.git_branch,
      userType: "external",
      entrypoint: "cli",
      leafUuid,
    });
  }

  return events;
}

function findLastUserIndex(session: PortableSession): number {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i]?.role === "user") return i;
  }
  return -1;
}
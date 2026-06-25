import { resolve } from "node:path";
import { detectAdapters, getAdapter } from "../adapters/registry.js";
import type { Adapter, SessionRef } from "../adapters/types.js";
import type { ToolName } from "../schema/portable.js";

/** Resolve [cwdArg] ?? process.cwd() into an absolute path. */
export function resolveCwd(cwdArg?: string): string {
  return resolve(cwdArg ?? process.cwd());
}

/**
 * Pick a tool to act on: explicit `--tool` wins; otherwise the
 * highest-confidence detected adapter. Returns null when nothing matches.
 */
export async function resolveTool(
  tool: ToolName | undefined,
  cwd: string
): Promise<ToolName | null> {
  if (tool) return tool;
  const detected = await detectAdapters(cwd);
  return detected[0]?.adapter.tool ?? null;
}

/**
 * Find a session by id or prefix within an adapter. Returns the first match.
 */
export async function findSession(
  adapter: Adapter,
  cwd: string,
  sessionId: string
): Promise<SessionRef | undefined> {
  for await (const r of adapter.listSessions(cwd)) {
    if (r.id === sessionId || r.id.startsWith(sessionId)) {
      return r;
    }
  }
  return undefined;
}

/** Convenience: getAdapter by tool, throwing a friendly message on miss. */
export function adapterFor(tool: ToolName): Adapter {
  return getAdapter(tool);
}
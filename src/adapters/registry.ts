import type { Adapter } from "./types.js";
import type { ToolName } from "../schema/portable.js";
import { ClaudeAdapter } from "./claude.js";
import { PukuAdapter } from "./puku.js";

const ADAPTERS: Adapter[] = [new ClaudeAdapter(), new PukuAdapter()];

export function getAdapter(tool: ToolName): Adapter {
  const found = ADAPTERS.find((a) => a.tool === tool);
  if (!found) {
    throw new Error(
      `No adapter registered for tool "${tool}". Supported: ${ADAPTERS.map((a) => a.tool).join(", ")}`
    );
  }
  return found;
}

export function listAdapters(): Adapter[] {
  return [...ADAPTERS];
}

/**
 * Run all adapters' canHandle against a cwd and rank by confidence.
 */
export async function detectAdapters(
  cwd: string
): Promise<Array<{ adapter: Adapter; confidence: number; cues: string[] }>> {
  const results = await Promise.all(
    ADAPTERS.map(async (adapter) => {
      const r = await adapter.canHandle(cwd);
      return { adapter, confidence: r.confidence, cues: r.cues };
    })
  );
  return results
    .filter((r) => r.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
}
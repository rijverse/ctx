import type { EntryState, StoreState } from "../types.js";
import { lstatSafe, readLinkAbs } from "../fs/ops.js";
import { samePath } from "../fs/paths.js";

/**
 * Classify an account's entry for a shared item without following the final
 * symlink. `expectedTarget` is the store path the entry should point at when
 * correctly linked.
 */
export async function classifyEntry(
  entryPath: string,
  expectedTarget: string
): Promise<EntryState> {
  const st = await lstatSafe(entryPath);
  if (!st) return "ABSENT";
  if (st.isSymbolicLink()) {
    const target = await readLinkAbs(entryPath);
    if (!(await lstatSafe(target))) return "BROKEN";
    return samePath(target, expectedTarget) ? "LINKED" : "WRONG_TARGET";
  }
  return st.isDirectory() ? "REAL_DIR" : "REAL_FILE";
}

export async function classifyStore(storePath: string): Promise<StoreState> {
  return (await lstatSafe(storePath)) ? "STORE_PRESENT" : "STORE_ABSENT";
}

import type { PlannedAction } from "../types.js";
import { copyRecursive, removeRecursive } from "../fs/ops.js";

/**
 * Replace a store symlink with an independent real copy of the current store
 * content. `rm` on a symlink removes the link, not its target, so the store is
 * left intact.
 */
export async function applyUnlinkAction(a: PlannedAction): Promise<void> {
  if (a.action !== "unlink") return;
  await removeRecursive(a.accountPath);
  await copyRecursive(a.storePath, a.accountPath);
}

export async function applyUnlink(actions: PlannedAction[]): Promise<void> {
  for (const a of actions) await applyUnlinkAction(a);
}

import { join } from "node:path";
import type { PlannedAction } from "../types.js";
import {
  atomicSymlink,
  mkdirp,
  moveWithExdevFallback,
  removeRecursive,
} from "../fs/ops.js";
import { mergeInto } from "./merge.js";

export interface ApplyLinkOptions {
  storeRoot: string;
  backup: boolean;
  backupDir?: string; // batch dir; used when backup is true
}

/**
 * Execute one link action. Destructive replacements always run
 * merge/seed -> free-account-path -> symlink, so the store holds a superset
 * before the account entry disappears (safe to interrupt at any step).
 */
export async function applyLinkAction(
  a: PlannedAction,
  opts: ApplyLinkOptions
): Promise<void> {
  switch (a.action) {
    case "noop":
    case "skip":
      return;
    case "adopt":
      await atomicSymlink(a.storePath, a.accountPath);
      return;
    case "seed":
      // Empty store slot: move the account's copy in, then point back at it.
      await moveWithExdevFallback(a.accountPath, a.storePath);
      await atomicSymlink(a.storePath, a.accountPath);
      return;
    case "merge":
      await mergeInto(a.accountPath, a.storePath, { storeRoot: opts.storeRoot });
      await freeAccountPath(a, opts);
      await atomicSymlink(a.storePath, a.accountPath);
      return;
    case "relink":
    case "repair":
      await freeAccountPath(a, opts);
      await atomicSymlink(a.storePath, a.accountPath);
      return;
    case "unlink":
      return; // handled by unlink.ts
  }
}

export async function applyLink(
  actions: PlannedAction[],
  opts: ApplyLinkOptions
): Promise<void> {
  for (const a of actions) await applyLinkAction(a, opts);
}

async function freeAccountPath(
  a: PlannedAction,
  opts: ApplyLinkOptions
): Promise<void> {
  if (opts.backup && opts.backupDir) {
    await mkdirp(opts.backupDir);
    await moveWithExdevFallback(a.accountPath, join(opts.backupDir, a.item.name));
  } else {
    await removeRecursive(a.accountPath);
  }
}

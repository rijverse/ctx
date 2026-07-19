import { join } from "node:path";
import type { Account, PlannedAction, SharedItem } from "../types.js";
import type { ResolvedConfig } from "../config/manifest.js";
import { classifyEntry, classifyStore } from "./state.js";
import { hashFile } from "../fs/ops.js";

/** Build the intended link actions for an account across the given items. */
export async function planLink(
  config: ResolvedConfig,
  account: Account,
  items: SharedItem[]
): Promise<PlannedAction[]> {
  const out: PlannedAction[] = [];
  for (const item of items) {
    const accountPath = join(account.dir, item.name);
    const storePath = join(config.storePath, item.name);
    const entryState = await classifyEntry(accountPath, storePath);
    const storeState = await classifyStore(storePath);
    const base = { account: account.name, item, accountPath, storePath, entryState, storeState };

    switch (entryState) {
      case "LINKED":
        out.push({ ...base, action: "noop", detail: "already linked" });
        break;
      case "BROKEN":
      case "WRONG_TARGET":
        if (storeState === "STORE_PRESENT") {
          out.push({ ...base, action: "repair", detail: "fix symlink to point at store" });
        } else {
          out.push({
            ...base,
            action: "skip",
            detail: `${entryState.toLowerCase()} symlink and store empty; run init first`,
          });
        }
        break;
      case "ABSENT":
        if (storeState === "STORE_PRESENT") {
          out.push({ ...base, action: "adopt", detail: "symlink to store" });
        } else {
          out.push({ ...base, action: "skip", detail: "not present" });
        }
        break;
      case "REAL_DIR":
        if (storeState === "STORE_PRESENT") {
          out.push({ ...base, action: "merge", detail: "merge into store, then symlink" });
        } else {
          out.push({ ...base, action: "seed", detail: "move into store, then symlink" });
        }
        break;
      case "REAL_FILE":
        if (storeState === "STORE_PRESENT") {
          const diverged = await filesDiffer(accountPath, storePath);
          out.push({
            ...base,
            action: "relink",
            diverged,
            detail: diverged
              ? "differs from store; store wins (account copy backed up)"
              : "back up and symlink to store",
          });
        } else {
          out.push({ ...base, action: "seed", detail: "move into store, then symlink" });
        }
        break;
    }
  }
  return out;
}

/** Build the intended unlink actions (dereference symlinks back to real copies). */
export async function planUnlink(
  config: ResolvedConfig,
  account: Account,
  items: SharedItem[]
): Promise<PlannedAction[]> {
  const out: PlannedAction[] = [];
  for (const item of items) {
    const accountPath = join(account.dir, item.name);
    const storePath = join(config.storePath, item.name);
    const entryState = await classifyEntry(accountPath, storePath);
    const storeState = await classifyStore(storePath);
    const base = { account: account.name, item, accountPath, storePath, entryState, storeState };

    switch (entryState) {
      case "LINKED":
        out.push({ ...base, action: "unlink", detail: "replace symlink with a real copy" });
        break;
      case "REAL_DIR":
      case "REAL_FILE":
        out.push({ ...base, action: "noop", detail: "already independent" });
        break;
      case "WRONG_TARGET":
      case "BROKEN":
        out.push({ ...base, action: "skip", detail: "not linked to store; run repair" });
        break;
      case "ABSENT":
        out.push({ ...base, action: "skip", detail: "not present" });
        break;
    }
  }
  return out;
}

/** Actions that actually change the filesystem. */
export function isMutating(a: PlannedAction): boolean {
  return a.action !== "noop" && a.action !== "skip";
}

async function filesDiffer(a: string, b: string): Promise<boolean> {
  try {
    return (await hashFile(a)) !== (await hashFile(b));
  } catch {
    return true;
  }
}

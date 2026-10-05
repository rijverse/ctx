import { lstat, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Plan, Step } from "../types.js";
import {
  copyInto,
  ensureDir,
  exists,
  mergeTree,
  move,
  removeEmptyDirs,
  replaceSymlink,
} from "../util/fsx.js";
import { dim, fail, out, yellow } from "../util/ui.js";
import type { Config } from "./config.js";
import { isGuarded } from "./inventory.js";
import { backupRoot, tilde } from "./paths.js";

export interface ApplyResult {
  done: number;
  backups: string[];
  collisions: string[];
}

/**
 * Run a plan. Every path that holds real data is either moved into the store or
 * moved into backups before anything is removed, and the only things ctx ever
 * deletes outright are a symlink it is about to replace and directories with no
 * files left in them. An interrupted run leaves the store a superset of what it
 * started with, so re-running is safe. Callers hold the store lock.
 */
export async function apply(
  plan: Plan,
  store: string,
  config: Config,
  opts: { verbose?: boolean } = {},
): Promise<ApplyResult> {
  const result: ApplyResult = { done: 0, backups: [], collisions: [] };
  if (plan.effective.length === 0) return result;

  const stamp = timestamp();
  await ensureDir(store);

  for (const step of plan.effective) {
    if (isGuarded(step.item.name)) {
      fail(`refusing to touch guarded entry ${step.item.name}`);
    }
    const backupDir = join(backupRoot(store, step.profile), stamp);

    switch (step.kind) {
      case "seed":
        await move(step.from, step.to);
        await replaceSymlink(step.from, step.to);
        break;

      case "absorb": {
        const collided = await mergeTree(step.from, step.to);
        result.collisions.push(...collided);
        // What is left should be empty directories. Anything else, a collision
        // or a file something wrote mid-merge, goes to backups, never to rm.
        await removeEmptyDirs(step.from);
        await stash(step, backupDir, config, result);
        await replaceSymlink(step.from, step.to);
        break;
      }

      case "stash":
        await stash(step, backupDir, config, result);
        await replaceSymlink(step.from, step.to);
        break;

      case "attach":
      case "relink":
        await replaceSymlink(step.from, step.to);
        break;

      case "detach":
        await detachOne(step);
        break;

      case "keep":
        continue;
    }

    result.done++;
    if (opts.verbose === true) out(dim(`  ${step.kind} ${tilde(step.from)}`));
  }

  return result;
}

/**
 * Copy the store's content next to the link first, then swap it in, so a copy
 * that fails halfway leaves the link working instead of a partial directory.
 */
async function detachOne(step: Step): Promise<void> {
  const tmp = `${step.from}.ctx-detach-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await copyInto(step.to, tmp);
  try {
    if (!(await lstat(step.from)).isSymbolicLink()) {
      fail(`${tilde(step.from)} is no longer a link, so it was left as it is`);
    }
    await rm(step.from);
    await rename(tmp, step.from);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

/** Park the profile's own copy out of the way. Never deletes it unless asked. */
async function stash(
  step: Step,
  backupDir: string,
  config: Config,
  result: ApplyResult,
): Promise<void> {
  if (!(await exists(step.from))) return;
  if (!config.backup) {
    await rm(step.from, { recursive: true, force: true });
    return;
  }
  const dest = join(backupDir, step.item.name);
  await move(step.from, dest);
  result.backups.push(dest);
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function warnCollisions(result: ApplyResult): void {
  if (result.collisions.length === 0) return;
  out(
    yellow(
      `  ${result.collisions.length} path(s) already existed in the store and were kept; your copies are in the backup.`,
    ),
  );
}

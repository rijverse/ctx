import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { isInside } from "../fs/paths.js";
import {
  copyRecursive,
  hashFile,
  lstatSafe,
  mkdirp,
  pathExists,
} from "../fs/ops.js";

export interface MergeResult {
  copied: number; // files/symlinks copied into the store
  conflicts: string[]; // relpaths where the store copy won over a differing account copy
  skipped: string[]; // unusual entry types (fifo/socket) left behind
}

/**
 * Recursively union `accountItem` into `storeItem`. Copies anything the store
 * lacks (preserving mode/mtime and copying inner symlinks verbatim); on a file
 * that exists in both with differing content, the store copy wins and the
 * relpath is recorded (the account's original is preserved by the caller's
 * pre-symlink backup). Non-destructive to the account.
 */
export async function mergeInto(
  accountItem: string,
  storeItem: string,
  opts: { storeRoot: string }
): Promise<MergeResult> {
  const result: MergeResult = { copied: 0, conflicts: [], skipped: [] };
  await mkdirp(storeItem);
  await walk("");
  return result;

  async function walk(rel: string): Promise<void> {
    const accDir = join(accountItem, rel);
    const entries = await fsp.readdir(accDir, { withFileTypes: true });
    for (const e of entries) {
      const childRel = rel ? join(rel, e.name) : e.name;
      const accPath = join(accountItem, childRel);
      const storePath = join(storeItem, childRel);

      if (e.isSymbolicLink()) {
        // Don't drag a link that already points into the store back into it.
        const target = await realpathSafe(accPath);
        if (target && isInside(target, opts.storeRoot)) continue;
        if (!(await pathExists(storePath))) {
          await mkdirp(dirname(storePath));
          await copyRecursive(accPath, storePath);
          result.copied++;
        }
        continue;
      }

      if (e.isDirectory()) {
        await ensureDirLike(accPath, storePath);
        await walk(childRel);
        continue;
      }

      if (e.isFile()) {
        if (!(await pathExists(storePath))) {
          await mkdirp(dirname(storePath));
          await copyRecursive(accPath, storePath);
          result.copied++;
        } else {
          const [ha, hb] = await Promise.all([
            hashFile(accPath),
            hashFile(storePath),
          ]);
          if (ha !== hb) result.conflicts.push(childRel);
        }
        continue;
      }

      result.skipped.push(childRel);
    }
  }
}

async function ensureDirLike(accPath: string, storePath: string): Promise<void> {
  if (await lstatSafe(storePath)) return;
  const st = await fsp.stat(accPath);
  await fsp.mkdir(storePath, { recursive: true });
  await fsp.chmod(storePath, st.mode & 0o777);
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

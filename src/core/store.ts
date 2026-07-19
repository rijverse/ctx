import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { Account, SharedItem } from "../types.js";
import type { ResolvedConfig } from "../config/manifest.js";
import { isInside, samePath } from "../fs/paths.js";
import { copyRecursive, lstatSafe, mkdirp, pathExists } from "../fs/ops.js";

/**
 * Refuse dangerous store locations: the home dir itself, an account dir, or a
 * path nested inside an account dir (linking would eat the account).
 */
export function assertStoreSafe(
  storePath: string,
  home: string,
  accounts: Account[]
): void {
  if (samePath(storePath, home)) {
    throw new Error(`ctx: store path must not be your home directory (${storePath})`);
  }
  for (const a of accounts) {
    if (samePath(storePath, a.dir)) {
      throw new Error(`ctx: store path must not be an account dir ("${a.name}")`);
    }
    if (isInside(storePath, a.dir)) {
      throw new Error(
        `ctx: store path must not live inside account dir "${a.name}" (${storePath})`
      );
    }
  }
}

export async function ensureStore(config: ResolvedConfig): Promise<void> {
  await mkdirp(config.storePath);
}

/**
 * Copy each shared item present as a real entry in `sourceDir` into the store,
 * but only when the store slot is empty. Never modifies the source; skips
 * items that are already symlinks (previously linked). Returns names seeded.
 */
export async function seedFromAccount(
  storePath: string,
  sourceDir: string,
  items: SharedItem[]
): Promise<string[]> {
  const seeded: string[] = [];
  for (const item of items) {
    const src = join(sourceDir, item.name);
    const dst = join(storePath, item.name);
    const srcStat = await lstatSafe(src);
    if (!srcStat || srcStat.isSymbolicLink()) continue;
    if (await pathExists(dst)) continue;
    await mkdirp(storePath);
    await copyRecursive(src, dst);
    seeded.push(item.name);
  }
  return seeded;
}

/** Ensure the backups directory exists for an account under the store. */
export async function backupBatchDir(
  storePath: string,
  backupRoot: string,
  account: string,
  stamp: string
): Promise<string> {
  const dir = join(storePath, backupRoot, account, stamp);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

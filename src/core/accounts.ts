import { promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import type { Account } from "../types.js";
import type { ResolvedConfig } from "../config/manifest.js";
import { samePath } from "../fs/paths.js";
import { lstatSafe } from "../fs/ops.js";

const PREFIX = ".claude-";

/**
 * Discover account config dirs: `~/.claude` (default) and every `~/.claude-*`
 * directory, excluding the shared store. Honors an explicit `accounts`
 * override in the config.
 */
export async function discoverAccounts(
  config: ResolvedConfig
): Promise<Account[]> {
  if (config.accountsOverride) {
    return config.accountsOverride.map((a) => ({
      name: a.name,
      dir: a.dir,
      isDefault: a.name === "default" || basename(a.dir) === ".claude",
    }));
  }

  let entries;
  try {
    entries = await fsp.readdir(config.accountsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const accounts: Account[] = [];
  for (const e of entries) {
    const name = e.name;
    if (name !== ".claude" && !name.startsWith(PREFIX)) continue;
    const dir = join(config.accountsRoot, name);
    if (samePath(dir, config.storePath)) continue; // never treat the store as an account

    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      isDir = (await lstatDeref(dir))?.isDirectory() ?? false;
    }
    if (!isDir) continue;

    accounts.push({
      name: name === ".claude" ? "default" : name.slice(PREFIX.length),
      dir,
      isDefault: name === ".claude",
    });
  }

  accounts.sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return accounts;
}

export function findAccount(
  accounts: Account[],
  name: string
): Account | undefined {
  return accounts.find((a) => a.name === name);
}

/** Like findAccount but throws a helpful error (and requires a name). */
export function requireAccount(
  accounts: Account[],
  name: string | undefined
): Account {
  if (!name) throw new Error("ctx: specify an account name or use --all");
  const found = findAccount(accounts, name);
  if (!found) {
    const known = accounts.map((a) => a.name).join(", ") || "(none)";
    throw new Error(`ctx: unknown account "${name}". Known: ${known}`);
  }
  return found;
}

export async function resolveAccount(
  config: ResolvedConfig,
  name: string
): Promise<Account> {
  const accounts = await discoverAccounts(config);
  const found = findAccount(accounts, name);
  if (!found) {
    const known = accounts.map((a) => a.name).join(", ") || "(none)";
    throw new Error(`ctx: unknown account "${name}". Known: ${known}`);
  }
  return found;
}

async function lstatDeref(p: string) {
  const st = await lstatSafe(p);
  if (st && st.isSymbolicLink()) {
    try {
      return await fsp.stat(p);
    } catch {
      return null;
    }
  }
  return st;
}

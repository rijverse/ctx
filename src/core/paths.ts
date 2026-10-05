import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Profile } from "../types.js";

export const DEFAULT_STORE = ".ctx-store";
export const CONFIG_FILE = "ctx.json";
export const BACKUPS_DIR = ".backups";
export const REGISTRY_SLICE = "registry.json";
export const LOCK_FILE = ".lock";
export const BASES_DIR = ".bases";

export function home(): string {
  return process.env.CTX_HOME ?? homedir();
}

export function expand(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/")) return join(home(), p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

export function tilde(p: string): string {
  const h = home();
  return p === h ? "~" : p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

export function storePath(override?: string): string {
  return expand(override ?? process.env.CTX_STORE ?? join(home(), DEFAULT_STORE));
}

export function configPath(store: string): string {
  return join(store, CONFIG_FILE);
}

export function backupRoot(store: string, profile: string): string {
  return join(store, BACKUPS_DIR, profile);
}

/** Store path for the shared slice of .claude.json. */
export function registrySlicePath(store: string): string {
  return join(store, REGISTRY_SLICE);
}

/**
 * What a profile's shared keys looked like the last time ctx folded it in. It
 * is the common ancestor for the next merge, which is what lets a deletion in
 * a profile be told apart from a profile that simply never had the entry.
 */
export function registryBasePath(store: string, profile: string): string {
  return join(store, BASES_DIR, `${profile}.json`);
}

export function storeLockPath(store: string): string {
  return join(store, LOCK_FILE);
}

/**
 * Claude puts .claude.json inside CLAUDE_CONFIG_DIR, except for the default
 * profile, where it sits next to the directory at ~/.claude.json.
 */
export function registryPathFor(dir: string): string {
  const isDefault = dir === join(home(), ".claude");
  return isDefault ? join(home(), ".claude.json") : join(dir, ".claude.json");
}

export function profileFromDir(dir: string): Profile {
  const abs = expand(dir);
  return {
    name: profileNameFromDir(abs),
    dir: abs,
    registryPath: registryPathFor(abs),
    isDefault: abs === join(home(), ".claude"),
  };
}

/**
 * "default" is only ever ~/.claude. ~/.claude-work is "work", a .claude dir
 * anywhere else is named after its parent (~/work/.claude is "work"), and any
 * other dir goes by its own name without a leading dot.
 */
export function profileNameFromDir(dir: string): string {
  if (dir === join(home(), ".claude")) return "default";
  const base = basename(dir);
  if (base === ".claude") return basename(dirname(dir)).replace(/^\./, "");
  if (base.startsWith(".claude-")) return base.slice(".claude-".length);
  return base.replace(/^\./, "");
}

export function profileDirFor(name: string): string {
  return join(home(), name === "default" ? ".claude" : `.claude-${name}`);
}


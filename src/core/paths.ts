import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Profile } from "../types.js";

export const DEFAULT_STORE = ".ctx-store";
export const CONFIG_FILE = "ctx.json";
export const BACKUPS_DIR = ".backups";
export const REGISTRY_SLICE = "registry.json";
export const LOCK_FILE = ".lock";

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

/** Store path for a profile's private slice of .claude.json. */
export function registrySlicePath(store: string): string {
  return join(store, REGISTRY_SLICE);
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
  const name = profileNameFromDir(abs);
  return {
    name,
    dir: abs,
    registryPath: registryPathFor(abs),
    isDefault: name === "default",
  };
}

export function profileNameFromDir(dir: string): string {
  const base = basename(dir);
  if (base === ".claude") return "default";
  return base.startsWith(".claude-") ? base.slice(".claude-".length) : base;
}

export function profileDirFor(name: string): string {
  return join(home(), name === "default" ? ".claude" : `.claude-${name}`);
}


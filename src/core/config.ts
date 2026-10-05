import { readJson, writeJson } from "../util/fsx.js";
import { fail } from "../util/ui.js";
import { defaultShared, isGuarded, itemByName } from "./inventory.js";
import { configPath } from "./paths.js";
import { SHARED_REGISTRY_KEYS } from "./registry.js";

/** A profile dir, optionally with the name ctx should use for it. */
export type ProfileEntry = string | { dir: string; name: string };

export interface Config {
  version: 1;
  /** Item names the store owns. Everything else stays per profile. */
  shared: string[];
  /** Top-level .claude.json keys the store owns. */
  registryKeys: string[];
  /** Move the profile's copy into backups before replacing it with a link. */
  backup: boolean;
  /**
   * Profile dirs outside the ~/.claude and ~/.claude-* naming, as absolute
   * paths. They are managed alongside the discovered ones, not instead of them.
   */
  profiles: ProfileEntry[];
  /**
   * The profile the store starts from. It is synced before any other, so on a
   * name collision its settings.json, CLAUDE.md and plugins are the ones kept.
   */
  seed?: string;
}

export function defaultConfig(): Config {
  return {
    version: 1,
    shared: defaultShared(),
    registryKeys: [...SHARED_REGISTRY_KEYS],
    backup: true,
    profiles: [],
  };
}

export async function loadConfig(store: string): Promise<Config | undefined> {
  const raw = await readJson<Partial<Config>>(configPath(store));
  if (raw === undefined) return undefined;
  return normalize(raw);
}

export async function saveConfig(store: string, config: Config): Promise<void> {
  await writeJson(configPath(store), normalize(config));
}

/**
 * Coerce a hand-edited config back into something safe. Unknown item names and
 * guarded ones are dropped rather than rejected, so a stray edit degrades to
 * "shares less" instead of bricking the tool.
 */
export function normalize(raw: Partial<Config>): Config {
  const base = defaultConfig();
  const shared = Array.isArray(raw.shared) ? raw.shared : base.shared;
  const keys = Array.isArray(raw.registryKeys) ? raw.registryKeys : base.registryKeys;

  const clean = shared.filter((name) => {
    if (typeof name !== "string") return false;
    if (isGuarded(name)) return false;
    return itemByName(name)?.role === "shared";
  });

  return {
    version: 1,
    shared: [...new Set(clean)],
    registryKeys: [...new Set(keys.filter((k) => typeof k === "string" && k !== "oauthAccount"))],
    backup: typeof raw.backup === "boolean" ? raw.backup : base.backup,
    profiles: Array.isArray(raw.profiles) ? raw.profiles.filter(isEntry) : [],
    ...(typeof raw.seed === "string" && raw.seed !== "" ? { seed: raw.seed } : {}),
  };
}

function isEntry(e: unknown): e is ProfileEntry {
  if (typeof e === "string") return true;
  const o = e as { dir?: unknown; name?: unknown } | null;
  return typeof o?.dir === "string" && typeof o.name === "string" && isProfileName(o.name);
}

/** Names end up in paths under the store, so they stay plain. */
export function isProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

export function entryDir(e: ProfileEntry): string {
  return typeof e === "string" ? e : e.dir;
}

export async function requireConfig(store: string): Promise<Config> {
  const config = await loadConfig(store);
  if (config === undefined) {
    fail(`no store at ${store}. Run \`ctx init\` first.`);
  }
  return config;
}

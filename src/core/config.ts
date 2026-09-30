import { readJson, writeJson } from "../util/fsx.js";
import { fail } from "../util/ui.js";
import { defaultShared, isGuarded, itemByName } from "./inventory.js";
import { configPath } from "./paths.js";
import { SHARED_REGISTRY_KEYS } from "./registry.js";

export interface Config {
  version: 1;
  /** Item names the store owns. Everything else stays per profile. */
  shared: string[];
  /** Top-level .claude.json keys the store owns. */
  registryKeys: string[];
  /** Move the profile's copy into backups before replacing it with a link. */
  backup: boolean;
  /** Profile dirs ctx manages, as absolute paths. Empty means auto-discover. */
  profiles: string[];
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
    profiles: Array.isArray(raw.profiles) ? raw.profiles.filter((p) => typeof p === "string") : [],
  };
}

export async function requireConfig(store: string): Promise<Config> {
  const config = await loadConfig(store);
  if (config === undefined) {
    fail(`no store at ${store}. Run \`ctx init\` first.`);
  }
  return config;
}

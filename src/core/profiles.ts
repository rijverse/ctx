import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Profile } from "../types.js";
import { isDir } from "../util/fsx.js";
import { fail } from "../util/ui.js";
import type { Config } from "./config.js";
import { expand, home, profileDirFor, profileFromDir, storePath } from "./paths.js";

/**
 * Find every Claude config dir in $HOME: ~/.claude plus ~/.claude-<name>.
 * The default store sits outside that namespace, but `--store ~/.claude-shared`
 * would land inside it, so the store is excluded explicitly either way.
 */
export async function discover(store = storePath()): Promise<Profile[]> {
  const h = home();
  const found: Profile[] = [];

  if (await isDir(join(h, ".claude"))) found.push(profileFromDir(join(h, ".claude")));

  let entries: string[];
  try {
    entries = await readdir(h);
  } catch {
    entries = [];
  }

  for (const name of entries.sort()) {
    if (!name.startsWith(".claude-")) continue;
    const dir = join(h, name);
    if (dir === store) continue;
    if (!(await isDir(dir))) continue;
    found.push(profileFromDir(dir));
  }

  return found;
}

export async function listProfiles(config: Config, store: string): Promise<Profile[]> {
  if (config.profiles.length > 0) {
    return config.profiles.map((p) => profileFromDir(expand(p)));
  }
  return discover(store);
}

export async function resolveProfile(
  name: string,
  config: Config,
  store: string,
): Promise<Profile> {
  const all = await listProfiles(config, store);
  const hit = all.find((p) => p.name === name);
  if (hit !== undefined) return hit;

  // Allow naming a profile that does not exist yet, so `ctx run new` can make it.
  const dir = profileDirFor(name);
  if (dir === store) fail(`"${name}" is the store, not a profile`);
  return profileFromDir(dir);
}

export function selectProfiles(all: Profile[], names: string[]): Profile[] {
  if (names.length === 0) return all;
  return names.map((name) => {
    const hit = all.find((p) => p.name === name);
    if (hit === undefined) {
      fail(`unknown profile "${name}". Known: ${all.map((p) => p.name).join(", ") || "none"}`);
    }
    return hit;
  });
}

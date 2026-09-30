import { join } from "node:path";
import type { Profile } from "../types.js";
import { readJson, writeJson } from "../util/fsx.js";
import { withLock } from "../util/lock.js";
import type { Config } from "./config.js";
import { LOCK_FILE, registrySlicePath } from "./paths.js";
import { compose, emptySlice, extract, mergeBack, type Registry, type Slice } from "./registry.js";

export async function readSlice(store: string): Promise<Slice> {
  return (await readJson<Slice>(registrySlicePath(store))) ?? emptySlice();
}

async function writeSlice(store: string, data: Registry): Promise<void> {
  await writeJson(registrySlicePath(store), {
    version: 1,
    updatedAt: new Date().toISOString(),
    data,
  } satisfies Slice);
}

/**
 * Push the store's shared .claude.json keys into a profile, so the session that
 * is about to start sees the project registry, trust decisions and MCP servers
 * everyone else has been building up.
 */
export async function pull(profile: Profile, store: string, config: Config): Promise<number> {
  const slice = await readSlice(store);
  const full = (await readJson<Registry>(profile.registryPath)) ?? {};
  const next = compose(full, slice.data, config.registryKeys);
  // .claude.json holds tokens for some auth types; keep Claude's own 0600.
  await writeJson(profile.registryPath, next, 0o600);
  return config.registryKeys.filter((k) => Object.hasOwn(slice.data, k)).length;
}

/**
 * Fold a profile's .claude.json back into the store. Held under a lock and
 * merged rather than overwritten, so two sessions ending at once do not drop
 * each other's projects.
 */
export async function push(profile: Profile, store: string, config: Config): Promise<number> {
  const full = await readJson<Registry>(profile.registryPath);
  if (full === undefined) return 0;

  return withLock(join(store, LOCK_FILE), async () => {
    const slice = await readSlice(store);
    const merged = mergeBack(slice.data, full, config.registryKeys);
    await writeSlice(store, merged);
    return Object.keys(extract(full, config.registryKeys)).length;
  });
}

/** Seed an empty store slice from a profile, used by `ctx init`. */
export async function seedSlice(profile: Profile, store: string, config: Config): Promise<number> {
  const full = (await readJson<Registry>(profile.registryPath)) ?? {};
  const data = extract(full, config.registryKeys);
  await writeSlice(store, data);
  return Object.keys(data).length;
}

import type { Profile } from "../types.js";
import { readJson, writeJson } from "../util/fsx.js";
import { withFileLock, withLock } from "../util/lock.js";
import { fail } from "../util/ui.js";
import type { Config } from "./config.js";
import { registryBasePath, registrySlicePath, storeLockPath, tilde } from "./paths.js";
import {
  compose,
  emptySlice,
  extract,
  isPlainObject,
  looksReset,
  mergeShared,
  type Registry,
  type Slice,
} from "./registry.js";

export interface Folded {
  /** Shared keys the store now holds. */
  keys: number;
  /** The profile looked reset, so it was restored from the store, not merged. */
  reset: boolean;
}

export async function readSlice(store: string): Promise<Slice> {
  const path = registrySlicePath(store);
  const raw = await readJson<Slice>(path);
  if (raw === undefined) return emptySlice();
  if (!isPlainObject(raw) || !isPlainObject(raw.data)) fail(`${tilde(path)} is not a ctx registry, so it was left untouched`);
  return raw;
}

// mcpServers can carry API keys in env, so the store copies get the same 0600
// Claude gives .claude.json.
async function writeSlice(store: string, data: Registry): Promise<void> {
  await writeJson(
    registrySlicePath(store),
    { version: 1, updatedAt: new Date().toISOString(), data } satisfies Slice,
    0o600,
  );
}

async function readBase(store: string, profile: Profile): Promise<Registry | undefined> {
  const raw = await readJson<{ data?: unknown }>(registryBasePath(store, profile.name));
  return isPlainObject(raw?.data) ? raw.data : undefined;
}

async function writeBase(store: string, profile: Profile, data: Registry): Promise<void> {
  await writeJson(registryBasePath(store, profile.name), { version: 1, data }, 0o600);
}

async function readRegistry(path: string): Promise<Registry | undefined> {
  const raw = await readJson<unknown>(path);
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) fail(`${tilde(path)} is not a JSON object, so it was left untouched`);
  return raw;
}

/** Merge one profile's shared keys into the store. Caller holds the store lock. */
async function fold(
  profile: Profile,
  store: string,
  config: Config,
  mine: Registry,
): Promise<{ data: Registry; reset: boolean }> {
  const slice = await readSlice(store);
  const base = await readBase(store, profile);
  if (base !== undefined && looksReset(base, mine)) return { data: slice.data, reset: true };

  const data = mergeShared(base ?? {}, slice.data, mine, config.registryKeys);
  await writeSlice(store, data);
  await writeBase(store, profile, extract(mine, config.registryKeys));
  return { data, reset: false };
}

function counted(data: Registry, config: Config): number {
  return Object.keys(extract(data, config.registryKeys)).length;
}

/**
 * Bring a profile up to date with the store before a session starts. Whatever
 * the profile changed since it last synced is folded in first, so a session
 * started without `ctx run` never has its work overwritten here.
 *
 * Runs under Claude's own .claude.json lock: Claude re-reads the file under
 * that lock before every save, so what is written here survives a session that
 * is already running.
 */
export async function pull(profile: Profile, store: string, config: Config): Promise<Folded> {
  return withLock(storeLockPath(store), () =>
    withFileLock(profile.registryPath, async () => {
      const mine = await readRegistry(profile.registryPath);
      const { data, reset } =
        mine === undefined ? { data: (await readSlice(store)).data, reset: false } : await fold(profile, store, config, mine);

      const next = compose(mine ?? {}, data, config.registryKeys);
      await writeJson(profile.registryPath, next, 0o600);
      await writeBase(store, profile, extract(next, config.registryKeys));
      return { keys: counted(data, config), reset };
    }),
  );
}

/**
 * Fold a profile's .claude.json into the store after a session. Held under the
 * store lock, so two sessions ending at once merge one after the other.
 */
export async function push(profile: Profile, store: string, config: Config): Promise<Folded> {
  return withLock(storeLockPath(store), async () => {
    const mine = await readRegistry(profile.registryPath);
    if (mine === undefined) return { keys: 0, reset: false };
    const { data, reset } = await fold(profile, store, config, mine);
    return { keys: counted(data, config), reset };
  });
}

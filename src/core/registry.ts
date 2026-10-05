/**
 * Splitting .claude.json.
 *
 * The file mixes two unrelated things: who you are logged in as, and what you
 * have been working on. Sharing it whole would make two accounts fight over
 * oauthAccount; sharing none of it means every profile re-trusts every project
 * and re-adds every MCP server. So ctx owns an allowlist of top-level keys and
 * leaves the rest of the file alone.
 *
 * The allowlist is deliberate. A key Claude adds in a future release is not
 * shared until someone puts it in ctx.json, which is the safe default for a
 * file that also holds entitlements.
 */

export type Registry = Record<string, unknown>;

export const SHARED_REGISTRY_KEYS = [
  "projects",
  "mcpServers",
  "tipsHistory",
  "tipsHistoryByCommand",
  "tipLifetimeShownCounts",
  "skillUsage",
  "pluginUsage",
  "githubRepoPaths",
  "hasCompletedOnboarding",
  "promptQueueUseCount",
] as const;

export interface Slice {
  version: 1;
  /** ISO timestamp of the last merge, for `ctx status`. */
  updatedAt: string;
  data: Registry;
}

export function emptySlice(): Slice {
  return { version: 1, updatedAt: new Date(0).toISOString(), data: {} };
}

/** Pull the shared keys out of a full .claude.json. */
export function extract(full: Registry, keys: readonly string[]): Registry {
  const out: Registry = {};
  for (const key of keys) {
    if (Object.hasOwn(full, key)) out[key] = full[key];
  }
  return out;
}

/**
 * Build the .claude.json a profile should run with: its own file, with the
 * shared keys replaced by the store's copy. Keys absent from the store are left
 * as the profile had them, so a first run adopts rather than wipes.
 */
export function compose(profileFull: Registry, slice: Registry, keys: readonly string[]): Registry {
  const out: Registry = { ...profileFull };
  for (const key of keys) {
    if (Object.hasOwn(slice, key)) out[key] = slice[key];
  }
  return out;
}

/**
 * Fold a profile's shared keys into the store's with a three-way merge.
 *
 * `base` is what this profile and the store last agreed on. A side that still
 * matches it has no opinion, so the other side's change wins, deletions
 * included: remove an MCP server in one profile and it is gone everywhere.
 * Objects merge entry by entry, so two profiles touching different projects
 * never collide. When both sides changed the same value, lists of plain values
 * merge as sets, a flag either side set stays set, an edit beats a deletion,
 * and otherwise the profile, being the latest writer, wins.
 *
 * A top-level key the profile lost entirely, or emptied when it used to have
 * entries, is read as no opinion. That is what a reset or freshly created
 * .claude.json looks like, and letting it count as "delete everything" would
 * spread one broken file to every account.
 */
export function mergeShared(
  base: Registry,
  store: Registry,
  profile: Registry,
  keys: readonly string[],
): Registry {
  const out: Registry = { ...store };
  for (const key of keys) {
    let mine = profile[key];
    if (mine === undefined || (isEmpty(mine) && !isEmpty(base[key]))) mine = base[key];
    const merged = merge3(base[key], store[key], mine);
    if (merged === undefined) delete out[key];
    else out[key] = merged;
  }
  return out;
}

/**
 * A profile whose project registry was emptied since the last fold has almost
 * certainly been reset or recreated, not curated down to nothing. Its shared
 * keys are then left out of the merge entirely and restored from the store.
 */
export function looksReset(base: Registry, profile: Registry): boolean {
  return !isEmpty(base["projects"]) && isEmpty(profile["projects"]);
}

function merge3(base: unknown, theirs: unknown, mine: unknown): unknown {
  if (deepEqual(mine, base)) return theirs;
  if (deepEqual(theirs, base) || deepEqual(theirs, mine)) return mine;

  if (isPlainObject(theirs) && isPlainObject(mine)) {
    const b = isPlainObject(base) ? base : {};
    const out: Registry = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      const v = merge3(b[k], theirs[k], mine[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (isValueList(theirs) && isValueList(mine)) {
    const was = isValueList(base) ? base : [];
    const dropped = new Set(was.filter((x) => !theirs.includes(x) || !mine.includes(x)));
    return [...new Set([...theirs, ...mine])].filter((x) => !dropped.has(x));
  }
  if (typeof theirs === "boolean" && typeof mine === "boolean") return theirs || mine;
  return mine === undefined ? theirs : mine;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  return isPlainObject(v) && Object.keys(v).length === 0;
}

function isValueList(v: unknown): v is (string | number | boolean)[] {
  return Array.isArray(v) && v.every((x) => ["string", "number", "boolean"].includes(typeof x));
}

export function isPlainObject(v: unknown): v is Registry {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Registry {
  return isPlainObject(v) ? v : {};
}

/** A short human summary of a slice, for status output. */
export function describe(slice: Registry): string {
  const projects = asRecord(slice["projects"]);
  const servers = asRecord(slice["mcpServers"]);
  const trusted = Object.values(projects).filter(
    (p) => isPlainObject(p) && p["hasTrustDialogAccepted"] === true,
  ).length;
  return `${Object.keys(projects).length} projects (${trusted} trusted), ${Object.keys(servers).length} mcp servers`;
}

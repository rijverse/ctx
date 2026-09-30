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

/** Per-project fields that are pure session bookkeeping, merged newest-wins. */
const PROJECT_TIMESTAMP_KEY = "lastSessionModified";

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
 * Fold a session's .claude.json back into the store slice. `projects` merges
 * per path and per field so two profiles working on different repos do not
 * erase each other; everything else is last-writer-wins on the key.
 */
export function mergeBack(slice: Registry, profileFull: Registry, keys: readonly string[]): Registry {
  const out: Registry = { ...slice };
  for (const key of keys) {
    if (!Object.hasOwn(profileFull, key)) continue;
    const incoming = profileFull[key];
    if (key === "projects") {
      out[key] = mergeProjects(asRecord(out[key]), asRecord(incoming));
    } else if (isPlainObject(incoming) && isPlainObject(out[key])) {
      out[key] = { ...asRecord(out[key]), ...asRecord(incoming) };
    } else {
      out[key] = incoming;
    }
  }
  return out;
}

function mergeProjects(current: Registry, incoming: Registry): Registry {
  const out: Registry = { ...current };
  for (const [path, entry] of Object.entries(incoming)) {
    const existing = out[path];
    if (!isPlainObject(entry) || !isPlainObject(existing)) {
      out[path] = entry;
      continue;
    }
    out[path] = newer(existing, entry) ? { ...entry, ...existing } : { ...existing, ...entry };
  }
  return out;
}

/** True when `a` is the fresher of two project entries. */
function newer(a: Registry, b: Registry): boolean {
  const ta = stamp(a[PROJECT_TIMESTAMP_KEY]);
  const tb = stamp(b[PROJECT_TIMESTAMP_KEY]);
  return ta > tb;
}

function stamp(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

function isPlainObject(v: unknown): v is Registry {
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

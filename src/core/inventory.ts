import type { Item, Role } from "../types.js";

/**
 * The full map of what Claude Code puts in a config directory. Anything not
 * listed here is treated as "local" and left alone, so a new Claude release can
 * add a file without ctx deciding on its behalf that it should be shared.
 */
export const INVENTORY: Item[] = [
  // Context. This is what the store exists for.
  { name: "projects", kind: "dir", role: "shared", note: "session transcripts" },
  { name: "todos", kind: "dir", role: "shared", note: "per-session todo lists" },
  { name: "file-history", kind: "dir", role: "shared", note: "edit history behind /rewind" },
  { name: "session-env", kind: "dir", role: "shared", note: "per-session environment" },
  { name: "tasks", kind: "dir", role: "shared", note: "background task state" },
  { name: "paste-cache", kind: "dir", role: "shared", note: "pasted content referenced by transcripts" },
  { name: "history.jsonl", kind: "file", role: "shared", note: "prompt history" },

  // Authored assets.
  { name: "skills", kind: "dir", role: "shared" },
  { name: "agents", kind: "dir", role: "shared" },
  { name: "commands", kind: "dir", role: "shared" },
  { name: "output-styles", kind: "dir", role: "shared" },
  { name: "rules", kind: "dir", role: "shared" },
  { name: "plans", kind: "dir", role: "shared" },
  { name: "memory", kind: "dir", role: "shared" },
  { name: "downloads", kind: "dir", role: "shared" },
  { name: "CLAUDE.md", kind: "file", role: "shared" },
  { name: "settings.json", kind: "file", role: "shared" },
  { name: "plugins", kind: "dir", role: "shared", note: "marketplaces and installed plugins" },

  // Identity and account-scoped state. Guarded: ctx refuses to move these.
  { name: ".credentials.json", kind: "file", role: "identity", note: "OAuth tokens" },
  { name: ".claude.json", kind: "file", role: "identity", note: "split by ctx, see `ctx registry`" },
  { name: "policy-limits.json", kind: "file", role: "identity" },
  { name: "policy-limits.json.stamp.json", kind: "file", role: "identity" },
  { name: "remote-settings.json", kind: "file", role: "identity" },
  { name: "stats-cache.json", kind: "file", role: "identity" },
  { name: "settings.local.json", kind: "file", role: "identity" },
  { name: "mcp-needs-auth-cache.json", kind: "file", role: "identity" },

  // Machine-local scratch.
  { name: "cache", kind: "dir", role: "local" },
  { name: "shell-snapshots", kind: "dir", role: "local" },
  { name: "sessions", kind: "dir", role: "local" },
  { name: "ide", kind: "dir", role: "local" },
  { name: "telemetry", kind: "dir", role: "local" },
  { name: "backups", kind: "dir", role: "local" },
  { name: "chrome", kind: "dir", role: "local" },
  { name: "daemon", kind: "dir", role: "local" },
  { name: "jobs", kind: "dir", role: "local" },
  { name: "feedback", kind: "dir", role: "local" },
];

const BY_NAME = new Map(INVENTORY.map((i) => [i.name, i]));

export function itemByName(name: string): Item | undefined {
  return BY_NAME.get(name);
}

export function itemsWithRole(role: Role): Item[] {
  return INVENTORY.filter((i) => i.role === role);
}

/** Default shareable set, used to seed a fresh config. */
export function defaultShared(): string[] {
  return itemsWithRole("shared").map((i) => i.name);
}

/**
 * Hard guard. Even a hand-edited config cannot get ctx to move or link these,
 * because losing one means losing a login or letting two accounts overwrite
 * each other's entitlements.
 */
export function isGuarded(name: string): boolean {
  if (BY_NAME.get(name)?.role === "identity") return true;
  // Claude writes .claude.json.tmp.<pid>.<rand> while saving; never touch those.
  if (name.startsWith(".claude.json.")) return true;
  if (name === "." || name === ".." || name.includes("/")) return true;
  return false;
}

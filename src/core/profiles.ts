import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Profile } from "../types.js";
import { isDir } from "../util/fsx.js";
import { fail } from "../util/ui.js";
import { entryDir, type Config } from "./config.js";
import { CONFIG_FILE, expand, home, profileDirFor, profileFromDir, storePath, tilde } from "./paths.js";

/**
 * Entries only Claude puts in a config dir. Other tools live in ~/.claude-*
 * too (claude-code-router, claude-squad, ...), and linking a store into one of
 * those would be wrong, so a ~/.claude-<name> dir needs one of these to count.
 * An empty dir counts as well: that is a profile nobody has started yet.
 */
const PROFILE_MARKERS = new Set([
  ".claude.json",
  ".credentials.json",
  "settings.json",
  "projects",
  "history.jsonl",
  "todos",
  "session-env",
  "file-history",
  "shell-snapshots",
  "statsig",
  "sessions",
  "CLAUDE.md",
]);

/** A store, this one or the ~/.claude-shared of earlier builds, is never a profile. */
const STORE_MARKERS = new Set([CONFIG_FILE, "ctx.config.json"]);

async function looksLikeProfile(dir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  if (names.some((n) => STORE_MARKERS.has(n))) return false;
  return names.length === 0 || names.some((n) => PROFILE_MARKERS.has(n));
}

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
    if (!(await isDir(dir)) || !(await looksLikeProfile(dir))) continue;
    found.push(profileFromDir(dir));
  }

  return found;
}

/**
 * The discovered profiles plus any added by path in ctx.json, in that order.
 * An entry with a name renames its dir, discovered or not.
 */
export async function listProfiles(config: Config, store: string, checkNames = true): Promise<Profile[]> {
  const profiles = await discover(store);
  for (const entry of config.profiles) {
    const dir = expand(entryDir(entry));
    let p = profiles.find((q) => q.dir === dir);
    if (p === undefined) {
      p = profileFromDir(dir);
      profiles.push(p);
    }
    if (typeof entry !== "string") p.name = entry.name;
  }
  if (checkNames) assertUniqueNames(profiles);
  assertStoreApart(store, profiles);
  return profiles;
}

/** Backups and merge bases are kept by profile name, so two dirs cannot share one. */
export function assertUniqueNames(profiles: Profile[]): void {
  const seen = new Map<string, Profile>();
  for (const p of profiles) {
    const other = seen.get(p.name);
    if (other !== undefined) {
      fail(
        `${tilde(other.dir)} and ${tilde(p.dir)} would both be called "${p.name}". ` +
          `Give one its own name with --as: \`ctx add ${tilde(p.dir)} --as <name>\`, ` +
          "or `ctx init --add <dir> --as <name>` before there is a store.",
      );
    }
    seen.set(p.name, p);
  }
}

/**
 * A store inside a profile, or a profile inside the store, would have ctx
 * moving a directory into itself and linking it to itself.
 */
export function assertStoreApart(store: string, profiles: Profile[]): void {
  const inside = (a: string, b: string) => a === b || a.startsWith(b + sep);
  for (const p of profiles) {
    if (inside(store, p.dir) || inside(p.dir, store)) {
      fail(`the store ${tilde(store)} overlaps the profile ${tilde(p.dir)}. Keep the store outside every Claude directory.`);
    }
  }
}

export async function resolveProfile(
  name: string,
  config: Config,
  store: string,
): Promise<Profile> {
  const all = await listProfiles(config, store);
  const hit = all.find((p) => p.name === name);
  if (hit !== undefined) return hit;

  const unmanaged = (await candidates(all, store)).find((c) => c.name === name);
  if (unmanaged !== undefined) {
    fail(`${tilde(unmanaged.dir)} is not managed yet. \`ctx add ${tilde(unmanaged.dir)}\` first.`);
  }

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

export interface Candidate {
  name: string;
  dir: string;
  /** How it was found, shown next to it. */
  why: string;
}

const STARTUP_FILES = [
  ".bashrc",
  ".bash_profile",
  ".bash_aliases",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".config/fish/config.fish",
];

// CLAUDE_CONFIG_DIR=... (sh, also inside an alias) or `set -x CLAUDE_CONFIG_DIR ...`
// (fish), but not a $CLAUDE_CONFIG_DIR read, and only values ctx can resolve.
const CONFIG_DIR_SET = /(?<![$\w{])CLAUDE_CONFIG_DIR(?:=|[ \t]+)["']?((?:~|\$HOME\b|\$\{HOME\}|\/)[^\s"';)`]*)/g;

/**
 * Claude config dirs that ctx is not managing, found the ways people end up
 * with one under some other name: CLAUDE_CONFIG_DIR set in this shell or in a
 * shell startup file, or a dir in ~ holding files only Claude writes there.
 *
 * These are only ever suggested. A copy of a profile kept as a backup looks
 * exactly like a profile, and syncing one would fold stale data into the store.
 */
export async function candidates(managed: Profile[], store: string): Promise<Candidate[]> {
  const h = home();
  const found = new Map<string, string>();
  const note = (dir: string, why: string) => {
    const abs = resolve(expand(dir.replace(/^(\$HOME\b|\$\{HOME\})/, h)));
    if (!found.has(abs)) found.set(abs, why);
  };

  const env = process.env["CLAUDE_CONFIG_DIR"];
  if (env !== undefined && env !== "") note(env, "CLAUDE_CONFIG_DIR in this shell");

  for (const file of STARTUP_FILES) {
    let text: string;
    try {
      text = await readFile(join(h, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      for (const m of line.matchAll(CONFIG_DIR_SET)) note(m[1]!, `CLAUDE_CONFIG_DIR in ~/${file}`);
    }
  }

  let entries: string[] = [];
  try {
    entries = await readdir(h);
  } catch {
    /* no home to scan */
  }
  for (const name of entries.sort()) {
    // ~/.claude and ~/.claude-* are discovery's business.
    if (name === ".claude" || name.startsWith(".claude-")) continue;
    const dir = join(h, name);
    let inside: string[];
    try {
      inside = await readdir(dir);
    } catch {
      continue;
    }
    const marker = [".claude.json", ".credentials.json"].find((m) => inside.includes(m));
    if (marker !== undefined) note(dir, `holds ${marker}`);
  }

  const out: Candidate[] = [];
  for (const [dir, why] of found) {
    if (managed.some((p) => p.dir === dir)) continue;
    if (dir === store || dir.startsWith(store + sep) || store.startsWith(dir + sep)) continue;
    if (!(await isDir(dir)) || !(await looksLikeProfile(dir))) continue;
    out.push({ name: profileFromDir(dir).name, dir, why });
  }
  return out;
}

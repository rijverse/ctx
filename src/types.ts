/** How a top-level entry in a profile directory is treated. */
export type Role =
  /** Canonical copy lives in the store; the profile gets a symlink. */
  | "shared"
  /** Identity or account-scoped state. Never moved, never linked. */
  | "identity"
  /** Machine-local scratch. Left where it is, not shared, not guarded. */
  | "local";

export interface Item {
  name: string;
  kind: "dir" | "file";
  role: Role;
  /** Shown in `ctx status --explain` and in the init picker. */
  note?: string;
}

/** A Claude config directory: `~/.claude` or `~/.claude-<name>`. */
export interface Profile {
  /** "default" for ~/.claude, otherwise the suffix: "me", "ekram", ... */
  name: string;
  dir: string;
  /**
   * Where Claude keeps this profile's .claude.json. The default profile is the
   * odd one out: it uses ~/.claude.json, not ~/.claude/.claude.json.
   */
  registryPath: string;
  isDefault: boolean;
}

/** lstat result for one profile entry, never following the final link. */
export type EntryState =
  | "absent"
  | "file"
  | "dir"
  | "linked" // symlink already resolving to the store slot
  | "misdirected" // symlink pointing somewhere else
  | "dangling"; // symlink whose target does not exist

export type StepKind =
  | "seed" // move the profile's copy into an empty store slot, then link
  | "absorb" // merge the profile's dir into an existing store dir, then link
  | "stash" // park a conflicting file in backups, then link
  | "attach" // store has it, profile does not: just link
  | "relink" // fix a misdirected or dangling link
  | "detach" // replace a link with a real copy of the store content
  | "keep"; // already correct, or nothing on either side

export interface Step {
  profile: string;
  item: Item;
  from: string; // path inside the profile
  to: string; // path inside the store
  state: EntryState;
  storeHas: boolean;
  kind: StepKind;
  detail?: string;
}

export interface Plan {
  steps: Step[];
  /** Steps that change something on disk, in the order they will run. */
  effective: Step[];
}

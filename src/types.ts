/** Shared item that can live in the store and be symlinked into an account. */
export interface SharedItem {
  name: string; // e.g. "projects" or "settings.json"
  kind: "dir" | "file";
}

/** A Claude CLI account: a config directory plus a name. */
export interface Account {
  name: string; // "default", "ekram", ...
  dir: string; // absolute path to the account config dir
  isDefault: boolean; // ~/.claude, whose identity file is $HOME/.claude.json
}

/**
 * State of an account's entry for a shared item, from an lstat that never
 * follows the final symlink. LINKED means "already points at the store".
 */
export type EntryState =
  | "ABSENT"
  | "REAL_FILE"
  | "REAL_DIR"
  | "LINKED"
  | "WRONG_TARGET"
  | "BROKEN";

export type StoreState = "STORE_PRESENT" | "STORE_ABSENT";

/** What a link/unlink run intends to do for one (account, item) pair. */
export type ActionKind =
  | "noop" // already in desired state
  | "skip" // nothing to share (absent on both sides)
  | "seed" // move real entry into an empty store slot, then symlink
  | "merge" // merge real dir into store, back up, then symlink
  | "adopt" // store present, account absent -> just symlink
  | "relink" // file: back up account copy, then symlink to store
  | "repair" // fix a wrong/broken symlink
  | "unlink"; // replace symlink with a real dereferenced copy

export interface PlannedAction {
  account: string;
  item: SharedItem;
  accountPath: string;
  storePath: string;
  entryState: EntryState;
  storeState: StoreState;
  action: ActionKind;
  /** Set when a file's content differs from the store copy (store-wins). */
  diverged?: boolean;
  /** Human-readable note for dry-run / confirm output. */
  detail?: string;
}

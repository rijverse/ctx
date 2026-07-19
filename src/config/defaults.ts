/** The on-disk config shape, fully populated. Files may specify a subset. */
export interface Manifest {
  version: number;
  storePath: string;
  accountsRoot: string;
  accounts?: { name: string; dir: string }[];
  shared: { directories: string[]; files: string[] };
  neverTouch: string[];
  ignore: string[];
  conflictPolicy: "store-wins";
  backups: boolean;
  seedFrom: string;
}

/**
 * Baked-in defaults so the tool works with no config file. The shared set
 * reflects the account owner's choices; `ctx init` lets them toggle items
 * before writing the config. Anything in `neverTouch` is identity/config that
 * stays per-account; `ignore` is ephemeral state we leave alone.
 */
export const DEFAULT_MANIFEST: Manifest = {
  version: 1,
  storePath: "~/.claude-shared",
  accountsRoot: "~",
  shared: {
    directories: [
      "projects",
      "todos",
      "commands",
      "agents",
      "output-styles",
      "skills",
      "rules",
      "plugins",
      "plans",
    ],
    files: ["settings.json", "CLAUDE.md", "history.jsonl"],
  },
  neverTouch: [
    ".credentials.json",
    ".claude.json",
    "policy-limits.json",
    "remote-settings.json",
    "settings.local.json",
    "mcp-needs-auth-cache.json",
    "stats-cache.json",
    ".last-cleanup",
    ".last-update-result.json",
    "settings.json.bak",
  ],
  ignore: [
    "cache",
    "paste-cache",
    "downloads",
    "shell-snapshots",
    "session-env",
    "ide",
    "sessions",
    "tasks",
    "telemetry",
    "backups",
    "file-history",
  ],
  conflictPolicy: "store-wins",
  backups: true,
  seedFrom: "default",
};

export const CONFIG_FILENAME = "ctx.config.json";
export const BACKUP_DIRNAME = ".ctx-backups";

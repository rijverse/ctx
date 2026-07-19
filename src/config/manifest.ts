import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { absPath } from "../fs/paths.js";
import { mkdirp } from "../fs/ops.js";
import type { SharedItem } from "../types.js";
import { CONFIG_FILENAME, DEFAULT_MANIFEST, type Manifest } from "./defaults.js";

/** On-disk config file: any subset of the manifest, merged over defaults. */
const FileSchema = z
  .object({
    version: z.number().optional(),
    storePath: z.string().optional(),
    accountsRoot: z.string().optional(),
    accounts: z
      .array(z.object({ name: z.string(), dir: z.string() }))
      .optional(),
    shared: z
      .object({
        directories: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
      })
      .optional(),
    neverTouch: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
    conflictPolicy: z.literal("store-wins").optional(),
    backups: z.boolean().optional(),
    seedFrom: z.string().optional(),
  })
  .strict();

export interface ResolvedConfig {
  storePath: string; // absolute
  accountsRoot: string; // absolute
  accountsOverride?: { name: string; dir: string }[]; // absolute dirs
  sharedItems: SharedItem[];
  sharedNames: Set<string>;
  neverTouch: Set<string>;
  ignore: Set<string>;
  conflictPolicy: "store-wins";
  backups: boolean;
  seedFrom: string;
  configPath: string; // absolute; may not exist yet
  manifest: Manifest; // effective merged manifest (unexpanded), for writing back
}

export interface LoadOptions {
  configPath?: string; // explicit config file (~ ok)
  storePath?: string; // CLI --store override (~ ok)
  home?: string; // override for tests
}

export async function loadConfig(opts: LoadOptions = {}): Promise<ResolvedConfig> {
  const home = opts.home ?? homedir();
  const exp = (p: string) => absPath(p, home);

  const baseStore = exp(opts.storePath ?? DEFAULT_MANIFEST.storePath);
  const configPath = opts.configPath
    ? exp(opts.configPath)
    : join(baseStore, CONFIG_FILENAME);

  let file: z.infer<typeof FileSchema> = {};
  try {
    const raw = await fsp.readFile(configPath, "utf8");
    file = FileSchema.parse(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `ctx: invalid config at ${configPath}: ${(err as Error).message}`
      );
    }
  }

  const manifest: Manifest = {
    version: file.version ?? DEFAULT_MANIFEST.version,
    storePath: opts.storePath ?? file.storePath ?? DEFAULT_MANIFEST.storePath,
    accountsRoot: file.accountsRoot ?? DEFAULT_MANIFEST.accountsRoot,
    accounts: file.accounts ?? DEFAULT_MANIFEST.accounts,
    shared: {
      directories:
        file.shared?.directories ?? DEFAULT_MANIFEST.shared.directories,
      files: file.shared?.files ?? DEFAULT_MANIFEST.shared.files,
    },
    neverTouch: file.neverTouch ?? DEFAULT_MANIFEST.neverTouch,
    ignore: file.ignore ?? DEFAULT_MANIFEST.ignore,
    conflictPolicy: file.conflictPolicy ?? DEFAULT_MANIFEST.conflictPolicy,
    backups: file.backups ?? DEFAULT_MANIFEST.backups,
    seedFrom: file.seedFrom ?? DEFAULT_MANIFEST.seedFrom,
  };

  const neverTouch = new Set(manifest.neverTouch);
  const sharedItems = toSharedItems(manifest);

  // Belt-and-suspenders: a config that lists a protected file as shared must
  // never be honored, or we could replace credentials with a symlink.
  for (const it of sharedItems) {
    if (neverTouch.has(it.name)) {
      throw new Error(
        `ctx: config error - "${it.name}" is in both shared and neverTouch; refusing to share protected config.`
      );
    }
  }

  return {
    storePath: exp(manifest.storePath),
    accountsRoot: exp(manifest.accountsRoot),
    accountsOverride: manifest.accounts?.map((a) => ({
      name: a.name,
      dir: exp(a.dir),
    })),
    sharedItems,
    sharedNames: new Set(sharedItems.map((i) => i.name)),
    neverTouch,
    ignore: new Set(manifest.ignore),
    conflictPolicy: manifest.conflictPolicy,
    backups: manifest.backups,
    seedFrom: manifest.seedFrom,
    configPath,
    manifest,
  };
}

export function toSharedItems(manifest: Manifest): SharedItem[] {
  return [
    ...manifest.shared.directories.map((name) => ({
      name,
      kind: "dir" as const,
    })),
    ...manifest.shared.files.map((name) => ({ name, kind: "file" as const })),
  ];
}

/**
 * Filter a config's shared items to a `--only` selection. Throws if a
 * requested name isn't a known shared item.
 */
export function selectItems(
  config: ResolvedConfig,
  only?: string[]
): SharedItem[] {
  if (!only || only.length === 0) return config.sharedItems;
  const wanted = new Set(only.flatMap((s) => s.split(",")).map((s) => s.trim()));
  const picked = config.sharedItems.filter((i) => wanted.has(i.name));
  const found = new Set(picked.map((i) => i.name));
  const missing = [...wanted].filter((n) => n && !found.has(n));
  if (missing.length) {
    throw new Error(
      `ctx: unknown shared item(s): ${missing.join(", ")}. Known: ${config.sharedItems
        .map((i) => i.name)
        .join(", ")}`
    );
  }
  return picked;
}

export async function writeConfig(
  configPath: string,
  manifest: Manifest
): Promise<void> {
  await mkdirp(dirname(configPath));
  await fsp.writeFile(configPath, JSON.stringify(manifest, null, 2) + "\n");
}

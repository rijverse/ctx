import { homedir } from "node:os";
import { join } from "node:path";
import type { SharedItem } from "../types.js";
import {
  type GlobalOpts,
  chooseSharedItems,
  confirm,
  fail,
  loadFromGlobals,
  out,
  success,
} from "./_util.js";
import { discoverAccounts, findAccount } from "../core/accounts.js";
import { assertStoreSafe, ensureStore, seedFromAccount } from "../core/store.js";
import { writeConfig } from "../config/manifest.js";
import { pathExists } from "../fs/ops.js";

export async function initCommand(
  g: GlobalOpts,
  opts: { from?: string }
): Promise<void> {
  const config = await loadFromGlobals(g);
  const accounts = await discoverAccounts(config);
  if (!accounts.length) {
    fail(`no Claude account dirs found under ${config.accountsRoot}`);
    process.exitCode = 1;
    return;
  }

  try {
    assertStoreSafe(config.storePath, homedir(), accounts);
  } catch (err) {
    fail((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const sourceName = opts.from ?? config.seedFrom;
  const source = findAccount(accounts, sourceName) ?? accounts[0]!;

  const entries = [];
  for (const item of config.sharedItems) {
    entries.push({
      name: item.name,
      present: await pathExists(join(source.dir, item.name)),
      checked: true,
    });
  }

  const interactive = !g.yes && !g.dryRun && Boolean(process.stdin.isTTY);
  let chosen: Set<string>;
  if (interactive) {
    out(`Seeding shared store from "${source.name}" (${source.dir}).`);
    out("Select which items to share across accounts:");
    chosen = await chooseSharedItems(entries);
  } else {
    chosen = new Set(config.sharedItems.map((i) => i.name));
  }

  const chosenItems: SharedItem[] = config.sharedItems.filter((i) =>
    chosen.has(i.name)
  );
  const manifest = {
    ...config.manifest,
    shared: {
      directories: chosenItems.filter((i) => i.kind === "dir").map((i) => i.name),
      files: chosenItems.filter((i) => i.kind === "file").map((i) => i.name),
    },
    seedFrom: source.name,
  };

  const toSeed: string[] = [];
  for (const it of chosenItems) {
    if (
      (await pathExists(join(source.dir, it.name))) &&
      !(await pathExists(join(config.storePath, it.name)))
    ) {
      toSeed.push(it.name);
    }
  }

  out(`\nstore:  ${config.storePath}`);
  out(`config: ${config.configPath}`);
  out(`seed from ${source.name}: ${toSeed.join(", ") || "(nothing new)"}`);

  if (g.dryRun) {
    out("\n(dry run) no changes written.");
    return;
  }
  if (!g.yes && interactive && !(await confirm("\nWrite store and config?"))) {
    out("Aborted.");
    return;
  }

  await ensureStore(config);
  await writeConfig(config.configPath, manifest);
  const seeded = await seedFromAccount(config.storePath, source.dir, chosenItems);
  success(`\nInitialized store. Seeded: ${seeded.join(", ") || "(nothing)"}`);
  out("Next: ctx link --all   (symlink accounts into the store)");
}

import { entryDir, isProfileName, saveConfig, type ProfileEntry } from "../core/config.js";
import { expand, profileFromDir, tilde } from "../core/paths.js";
import { assertStoreApart, assertUniqueNames, listProfiles } from "../core/profiles.js";
import { flagString, type Parsed } from "../util/args.js";
import { isDir } from "../util/fsx.js";
import { dim, fail, green, out } from "../util/ui.js";
import { context } from "./_context.js";

/**
 * Manage a profile that lives outside ~/.claude-*, wherever CLAUDE_CONFIG_DIR
 * points for it, or give any profile a name of its own with --as. Only the
 * config changes here. `ctx sync` does the linking.
 */
export async function add(args: Parsed): Promise<number> {
  const ctx = await context(args);
  const as = flagString(args, "as");
  if (args.positionals.length === 0) fail("usage: ctx add <dir>... [--as <name>]");
  if (as !== undefined && args.positionals.length > 1) fail("--as names one profile, so give it one dir");
  if (as !== undefined && !isProfileName(as)) fail(`"${as}" is not a usable name. Use letters, digits, ".", "_" and "-".`);

  // Unchecked, because resolving a name clash is one of the things --as is for.
  const all = await listProfiles(ctx.config, ctx.store, false);
  let entries: ProfileEntry[] = [...ctx.config.profiles];
  let changed = 0;

  for (const raw of args.positionals) {
    const dir = expand(raw);
    if (!(await isDir(dir))) fail(`${tilde(dir)} is not a directory`);
    if (as === "default" && dir !== profileFromDir("~/.claude").dir) fail(`"default" is kept for ~/.claude`);

    const known = all.find((p) => p.dir === dir);
    if (known !== undefined && (as === undefined || as === known.name)) {
      out(`${known.name} ${dim(tilde(dir))} is already managed`);
      continue;
    }

    const p = known ?? profileFromDir(dir);
    const before = p.name;
    if (as !== undefined) p.name = as;
    assertStoreApart(ctx.store, [p]);

    entries = entries.filter((e) => expand(entryDir(e)) !== dir);
    entries.push(as === undefined ? dir : { dir, name: as });
    if (known === undefined) all.push(p);
    changed++;
    out(known === undefined ? `${green("added")} ${p.name} ${dim(tilde(dir))}` : `${green("renamed")} ${before} to ${p.name} ${dim(tilde(dir))}`);
  }

  if (changed === 0) return 0;
  assertUniqueNames(all);
  if (ctx.dryRun) {
    out(dim("--dry-run: nothing was changed."));
    return 0;
  }
  await saveConfig(ctx.store, { ...ctx.config, profiles: entries });
  out(dim("`ctx sync <name>` links it to the store, `ctx run <name>` launches it."));
  return 0;
}

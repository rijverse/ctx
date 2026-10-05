import { join } from "node:path";
import { defaultConfig, entryDir, isProfileName, loadConfig, saveConfig, type Config } from "../core/config.js";
import { itemByName } from "../core/inventory.js";
import { CONFIG_FILE, expand, home, tilde } from "../core/paths.js";
import { candidates, listProfiles } from "../core/profiles.js";
import { describe } from "../core/registry.js";
import { push, readSlice } from "../core/session.js";
import { flagList, flagString, type Parsed } from "../util/args.js";
import { ensureDir, exists, isDir } from "../util/fsx.js";
import { bold, confirm, cyan, dim, fail, green, out, pad, yellow } from "../util/ui.js";
import { globals } from "./_context.js";

export async function init(args: Parsed): Promise<number> {
  const g = globals(args);
  const store = g.store;
  const existing = await loadConfig(store);

  if (existing !== undefined && !args.flags.has("force")) {
    out(`Store already set up at ${cyan(tilde(store))}.`);
    out(dim("`ctx status` to see it, `ctx init --force` to rewrite the config."));
    return 0;
  }

  const config: Config = existing ?? defaultConfig();
  const adding = flagList(args, "add") ?? [];
  const as = flagString(args, "as");
  if (as !== undefined && (adding.length !== 1 || !isProfileName(as))) {
    fail("--as names the one dir given with --add, using letters, digits, \".\", \"_\" and \"-\"");
  }
  for (const dir of adding) {
    const abs = expand(dir);
    if (!(await isDir(abs))) fail(`--add ${dir}: not a directory`);
    config.profiles = config.profiles.filter((e) => expand(entryDir(e)) !== abs);
    config.profiles.push(as === undefined ? abs : { dir: abs, name: as });
  }

  let profiles = await listProfiles(config, store);

  // A config dir under some other name, ~/.my-claude say, is offered rather
  // than taken: a backup copy of a profile looks just like one.
  const found = await candidates(profiles, store);
  if (found.length > 0) {
    out();
    out(bold("Found, not managed yet"));
    for (const c of found) out(`  ${pad(c.name, 12)} ${dim(pad(tilde(c.dir), 22))} ${dim(c.why)}`);
    if (g.yes || g.dryRun || !process.stdin.isTTY) {
      out(dim(`  \`--add <dir>\` takes one in, for example --add ${tilde(found[0]!.dir)}`));
    } else {
      for (const c of found) {
        if (await confirm(`Manage ${tilde(c.dir)} as "${c.name}"?`)) config.profiles.push(c.dir);
      }
      profiles = await listProfiles(config, store);
    }
  }

  if (profiles.length === 0) {
    // Found dirs nobody was asked about are far likelier to be the user's
    // accounts than a reason to start from nothing.
    if (found.length > 0 && (g.yes || !process.stdin.isTTY)) {
      fail(`nothing is managed yet. Take your Claude dir in with --add, for example \`ctx init --add ${tilde(found[0]!.dir)}\`.`);
    }
    return startEmpty(store, config, args);
  }

  // Whoever seeds the store decides whose settings.json and plugins everyone
  // gets, so without ~/.claude to default to, that is never guessed.
  const seedName =
    flagString(args, "from") ??
    config.seed ??
    profiles.find((p) => p.isDefault)?.name ??
    (profiles.length === 1 ? profiles[0]!.name : undefined);
  if (seedName === undefined) {
    fail(
      `there is no ~/.claude, so pick the profile the store starts from: \`ctx init --from <profile>\`. ` +
        `Its settings.json, CLAUDE.md and plugins win over the others'. Found: ${profiles.map((p) => p.name).join(", ")}`,
    );
  }
  const seed = profiles.find((p) => p.name === seedName);
  if (seed === undefined) {
    fail(`--from ${seedName}: no such profile. Found: ${profiles.map((p) => p.name).join(", ")}`);
  }

  config.seed = seed.name;
  if (g.only !== undefined) {
    config.shared = g.only.filter((n) => itemByName(n)?.role === "shared");
  }

  out();
  out(`${bold("Store")}  ${cyan(tilde(store))}`);
  out();
  out(bold("Profiles"));
  for (const p of profiles) {
    const tag = p.name === seed.name ? green("   seeds the store") : "";
    out(`  ${pad(p.name, 12)} ${dim(pad(tilde(p.dir), 22))}${tag}`);
  }

  out();
  out(bold("Shared"));
  out(dim("  moved into the store once, then symlinked back into every profile"));
  for (const name of config.shared) {
    const item = itemByName(name)!;
    const mark = (await exists(join(seed.dir, name))) ? green("*") : dim("-");
    out(`  ${mark} ${pad(name, 18)} ${dim(item.note ?? "")}`);
  }
  out(dim(`  * present in ${seed.name}`));

  out();
  out(bold("Never touched"));
  out(dim("  .credentials.json  .claude.json  policy-limits.json  remote-settings.json"));
  out(dim("  stats-cache.json  settings.local.json  and the local caches"));

  out();
  out(bold(".claude.json"));
  out(`  ${dim("shared keys")}  ${config.registryKeys.join(", ")}`);
  out(`  ${dim("per profile")}  oauthAccount, userID, machineID, entitlement caches, everything else`);
  out();

  if (g.dryRun) {
    out(dim("--dry-run: nothing was changed."));
    return 0;
  }
  if (!g.yes && !(await confirm("Create the store with this layout?"))) {
    out(yellow("Cancelled. Nothing was changed."));
    return 1;
  }

  await ensureDir(store);
  await saveConfig(store, config);
  // A merge, not a copy: on --force the store may already hold what other
  // profiles folded in, and rewriting the config must not throw that away.
  const seeded = await push(seed, store, config);
  if (seeded.reset) out(yellow(`${tilde(seed.registryPath)} looks reset, so the store's registry was kept as it is.`));
  const slice = await readSlice(store);

  out();
  out(green(`Created ${tilde(store)}`));
  out(`  ${pad("config", 10)} ${dim(tilde(join(store, CONFIG_FILE)))}`);
  out(`  ${pad("registry", 10)} ${dim(describe(slice.data))}`);
  out();
  out(bold("Next"));
  out(`  ctx sync --all    ${dim("fold every profile into the store")}`);
  out(`  ctx status        ${dim("check the result")}`);
  return 0;
}

/**
 * Nobody has used Claude here yet. The store starts empty, and the first
 * account started with `ctx run` fills it and becomes the seed, unless --from
 * names one up front.
 */
async function startEmpty(store: string, config: Config, args: Parsed): Promise<number> {
  const g = globals(args);
  const from = flagString(args, "from");
  if (from !== undefined && !isProfileName(from)) fail(`--from ${from}: not a usable profile name`);
  if (from !== undefined) config.seed = from;
  else delete config.seed;

  out();
  out(`${bold("Store")}  ${cyan(tilde(store))}`);
  out();
  out(`No Claude profiles under ${tilde(home())} yet, so the store starts empty.`);
  out(dim(`  The first account you start with \`ctx run\` fills it${from === undefined ? " and becomes its seed" : ""}.`));
  out();

  if (g.dryRun) {
    out(dim("--dry-run: nothing was changed."));
    return 0;
  }
  if (!g.yes && !(await confirm("Create the empty store?"))) {
    out(yellow("Cancelled. Nothing was changed."));
    return 1;
  }
  await ensureDir(store);
  await saveConfig(store, config);

  out();
  out(green(`Created ${tilde(store)}`));
  out();
  out(bold("Next, once per account"));
  out(`  ctx run default   ${dim("~/.claude, the account plain `claude` uses. Log in, use it, exit.")}`);
  out(`  ctx run work      ${dim("~/.claude-work, a second login that shares everything else")}`);
  return 0;
}

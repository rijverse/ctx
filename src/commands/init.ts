import { join } from "node:path";
import { defaultConfig, loadConfig, saveConfig, type Config } from "../core/config.js";
import { itemByName } from "../core/inventory.js";
import { CONFIG_FILE, home, tilde } from "../core/paths.js";
import { discover } from "../core/profiles.js";
import { describe } from "../core/registry.js";
import { readSlice, seedSlice } from "../core/session.js";
import { flagString, type Parsed } from "../util/args.js";
import { ensureDir, exists } from "../util/fsx.js";
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

  const profiles = await discover(store);
  if (profiles.length === 0) {
    fail(`no Claude config directories under ${tilde(home())}. Run claude once first.`);
  }

  const seedName = flagString(args, "from") ?? profiles.find((p) => p.isDefault)?.name ?? profiles[0]!.name;
  const seed = profiles.find((p) => p.name === seedName);
  if (seed === undefined) {
    fail(`--from ${seedName}: no such profile. Found: ${profiles.map((p) => p.name).join(", ")}`);
  }

  const config: Config = existing ?? defaultConfig();
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
  await seedSlice(seed, store, config);
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

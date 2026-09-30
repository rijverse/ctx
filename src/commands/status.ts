import { join } from "node:path";
import type { EntryState, Profile } from "../types.js";
import { loadConfig } from "../core/config.js";
import { INVENTORY, itemByName } from "../core/inventory.js";
import { stateOf } from "../core/plan.js";
import { tilde } from "../core/paths.js";
import { listProfiles } from "../core/profiles.js";
import { describe } from "../core/registry.js";
import { readSlice } from "../core/session.js";
import type { Parsed } from "../util/args.js";
import { dirSize, exists } from "../util/fsx.js";
import { bold, cyan, dim, green, out, pad, red, yellow } from "../util/ui.js";
import { globals } from "./_context.js";

export async function status(args: Parsed): Promise<number> {
  const g = globals(args);
  const config = await loadConfig(g.store);

  if (config === undefined) {
    if (g.json) {
      out(JSON.stringify({ store: g.store, initialized: false }, null, 2));
      return 1;
    }
    out(`${yellow("No store")} at ${cyan(tilde(g.store))}`);
    out(dim("Run `ctx init` to create one."));
    return 1;
  }

  const profiles = await listProfiles(config, g.store);
  const rows: { profile: Profile; states: Map<string, EntryState> }[] = [];

  for (const profile of profiles) {
    const states = new Map<string, EntryState>();
    for (const name of config.shared) {
      states.set(name, await stateOf(join(profile.dir, name), join(g.store, name)));
    }
    rows.push({ profile, states });
  }

  if (g.json) {
    out(
      JSON.stringify(
        {
          store: g.store,
          initialized: true,
          shared: config.shared,
          registryKeys: config.registryKeys,
          profiles: rows.map((r) => ({
            name: r.profile.name,
            dir: r.profile.dir,
            registry: r.profile.registryPath,
            items: Object.fromEntries(r.states),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const slice = await readSlice(g.store);
  const bytes = await dirSize(g.store);

  out();
  out(`${bold("Store")}  ${cyan(tilde(g.store))}  ${dim(human(bytes))}`);
  out(`${dim("registry")}  ${describe(slice.data)}  ${dim(stamp(slice.updatedAt))}`);
  out();

  const width = Math.max(...config.shared.map((n) => n.length), 8) + 2;
  const nameWidth = Math.max(...profiles.map((p) => p.name.length), 7) + 2;

  out(`  ${pad(dim("item"), width)}${profiles.map((p) => pad(bold(p.name), nameWidth)).join("")}`);
  for (const name of config.shared) {
    const cells = rows.map((r) => pad(mark(r.states.get(name)!), nameWidth));
    out(`  ${pad(name, width)}${cells.join("")}`);
  }

  out();
  out(dim(`  ${green("link")} into the store   ${yellow("own")} unshared copy   ${dim("-")} absent   ${red("broken")} needs \`ctx doctor\``));

  const unmanaged = await findUnmanaged(profiles, config.shared);
  if (unmanaged.length > 0) {
    out();
    out(`${bold("Not managed by ctx")} ${dim("(left alone)")}`);
    out(dim(`  ${unmanaged.join("  ")}`));
  }

  out();
  for (const profile of profiles) {
    out(`  ${pad(profile.name, nameWidth)} ${dim(tilde(profile.dir))}`);
  }
  out();
  return 0;
}

function mark(state: EntryState): string {
  switch (state) {
    case "linked":
      return green("link");
    case "dir":
    case "file":
      return yellow("own");
    case "absent":
      return dim("-");
    case "misdirected":
      return red("elsewhere");
    case "dangling":
      return red("broken");
  }
}

/** Entries ctx knows about but is not sharing, so the picture is honest. */
async function findUnmanaged(profiles: Profile[], shared: string[]): Promise<string[]> {
  const names = new Set<string>();
  for (const item of INVENTORY) {
    if (item.role !== "shared" || shared.includes(item.name)) continue;
    for (const p of profiles) {
      if (await exists(join(p.dir, item.name))) {
        names.add(item.name);
        break;
      }
    }
  }
  return [...names].filter((n) => itemByName(n) !== undefined).sort();
}

function human(bytes: number): string {
  const units = ["B", "K", "M", "G"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${units[i]}`;
}

function stamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t === 0) return "never merged";
  return `merged ${new Date(t).toLocaleString()}`;
}

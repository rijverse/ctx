import { readJson } from "../util/fsx.js";
import { tilde } from "../core/paths.js";
import { resolveProfile } from "../core/profiles.js";
import { describe, extract, type Registry } from "../core/registry.js";
import { pull, push, readSlice } from "../core/session.js";
import type { Parsed } from "../util/args.js";
import { bold, cyan, dim, fail, green, out, pad, yellow } from "../util/ui.js";
import { context } from "./_context.js";

/**
 * Manual control over the .claude.json split. `ctx run` and the session hooks
 * call the same two operations; this is the escape hatch when you started
 * claude some other way.
 */
export async function registry(args: Parsed): Promise<number> {
  const ctx = await context(args);
  const action = args.positionals[0] ?? "show";
  const name = args.positionals[1];

  if (action === "show") {
    const slice = await readSlice(ctx.store);
    if (ctx.json) {
      out(JSON.stringify(slice, null, 2));
      return 0;
    }
    out();
    out(`${bold("Shared .claude.json")}  ${dim(tilde(ctx.store))}`);
    out(`  ${describe(slice.data)}`);
    out(`  ${dim(`updated ${slice.updatedAt}`)}`);
    out();
    out(bold("Keys"));
    for (const key of ctx.config.registryKeys) {
      const present = Object.hasOwn(slice.data, key);
      out(`  ${present ? green("*") : dim("-")} ${key}`);
    }
    out();
    return 0;
  }

  if (name === undefined) fail(`usage: ctx registry ${action} <profile>`);
  const profile = await resolveProfile(name, ctx.config, ctx.store);

  if (action === "pull") {
    if (ctx.dryRun) {
      const slice = await readSlice(ctx.store);
      out(dim(`--dry-run: would write ${Object.keys(slice.data).length} key(s) into ${tilde(profile.registryPath)}`));
      return 0;
    }
    const n = await pull(profile, ctx.store, ctx.config);
    if (n.reset) out(yellow(`${tilde(profile.registryPath)} looked reset, so it was restored from the store.`));
    out(`${green("pulled")} ${n.keys} key(s) into ${cyan(tilde(profile.registryPath))}`);
    return 0;
  }

  if (action === "push") {
    if (ctx.dryRun) {
      const full = (await readJson<Registry>(profile.registryPath)) ?? {};
      const keys = Object.keys(extract(full, ctx.config.registryKeys));
      out(dim(`--dry-run: would merge ${keys.length} key(s) into the store: ${keys.join(", ")}`));
      return 0;
    }
    const n = await push(profile, ctx.store, ctx.config);
    if (n.reset) {
      out(yellow(`${tilde(profile.registryPath)} looks reset, so it was not pushed. \`ctx registry pull ${profile.name}\` restores it.`));
      return 1;
    }
    out(`${green("pushed")} ${cyan(profile.name)} into the store, which holds ${n.keys} shared key(s)`);
    return 0;
  }

  if (action === "diff") {
    const slice = await readSlice(ctx.store);
    const full = (await readJson<Registry>(profile.registryPath)) ?? {};
    const mine = extract(full, ctx.config.registryKeys);
    out();
    out(`${bold("key")}${" ".repeat(20)}${bold("store")}   ${bold(profile.name)}`);
    for (const key of ctx.config.registryKeys) {
      const a = count(slice.data[key]);
      const b = count(mine[key]);
      const same = a === b;
      out(`  ${pad(key, 24)} ${pad(String(a), 7)} ${same ? dim(String(b)) : cyan(String(b))}`);
    }
    out();
    return 0;
  }

  fail(`unknown registry action "${action}". Use show, pull, push or diff.`);
}

function count(v: unknown): number | string {
  if (v === undefined) return "-";
  if (Array.isArray(v)) return v.length;
  if (typeof v === "object" && v !== null) return Object.keys(v).length;
  return 1;
}

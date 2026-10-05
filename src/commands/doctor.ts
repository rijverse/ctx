import { basename, dirname, join } from "node:path";
import type { Plan, Profile } from "../types.js";
import { apply } from "../core/apply.js";
import { planRepair, planSync } from "../core/plan.js";
import { storeLockPath, tilde } from "../core/paths.js";
import { listProfiles, selectProfiles } from "../core/profiles.js";
import type { Parsed } from "../util/args.js";
import { exists, isWritable } from "../util/fsx.js";
import { withLock } from "../util/lock.js";
import { bold, confirm, dim, green, out, pad, red, yellow } from "../util/ui.js";
import { context } from "./_context.js";

/** Find and fix the things that break a symlinked setup in practice. */
export async function doctor(args: Parsed): Promise<number> {
  const ctx = await context(args);
  const all = await listProfiles(ctx.config, ctx.store);
  const wanted = args.positionals.length > 0 ? selectProfiles(all, args.positionals) : all;

  const problems: string[] = [];

  if (!(await isWritable(ctx.store))) problems.push(`store is not writable: ${tilde(ctx.store)}`);

  out();
  out(`${bold("Store")}  ${dim(tilde(ctx.store))}`);

  let broken = 0;
  const fixes: { profile: Profile; plan: Plan }[] = [];
  for (const profile of wanted) {
    const plan = await planRepair(profile, ctx.store, ctx.config);
    broken += plan.effective.length;
    fixes.push({ profile, plan });

    // A real copy where the store expects a link: something replaced the link,
    // or the profile was never synced for this item. Either way it no longer
    // sees the shared data, and folding it in is sync's job, with backups.
    const own = (await planSync(profile, ctx.store, ctx.config)).effective.filter(
      (s) => s.kind === "absorb" || s.kind === "stash",
    );
    if (own.length > 0) {
      problems.push(`${profile.name}: ${own.length} item(s) not linked to the store. \`ctx sync ${profile.name}\` folds them in.`);
    }

    const stray = await strayRegistryTemp(profile.registryPath);
    if (stray.length > 0) {
      problems.push(`${profile.name}: ${stray.length} leftover .claude.json temp file(s) next to ${tilde(profile.registryPath)}`);
    }

    out();
    out(`  ${bold(profile.name)} ${dim(tilde(profile.dir))}`);
    if (plan.effective.length === 0 && own.length === 0) {
      out(`    ${green("no broken links")}`);
      continue;
    }
    for (const step of plan.effective) {
      out(`    ${red(pad("broken", 9))} ${pad(step.item.name, 18)} ${dim(step.detail ?? "")}`);
    }
    for (const step of own) {
      out(`    ${yellow(pad("unlinked", 9))} ${pad(step.item.name, 18)} ${dim(`own ${step.state}, the store has one too`)}`);
    }
  }

  if (problems.length > 0) {
    out();
    out(bold("Also"));
    for (const p of problems) out(`  ${yellow("!")} ${p}`);
  }

  out();
  if (broken === 0) {
    out(green("Nothing to repair."));
    return problems.length > 0 ? 1 : 0;
  }
  if (ctx.dryRun) {
    out(dim(`--dry-run: ${broken} link(s) would be repaired.`));
    return 0;
  }
  if (!ctx.yes && !(await confirm(`Repair ${broken} link(s)?`))) {
    out(yellow("Cancelled. Nothing was changed."));
    return 1;
  }

  await withLock(storeLockPath(ctx.store), async () => {
    for (const { profile, plan } of fixes) {
      if (plan.effective.length === 0) continue;
      const result = await apply(plan, ctx.store, ctx.config, { verbose: ctx.verbose });
      out(`${green("ok")} ${pad(profile.name, 12)} ${result.done} link(s) repaired`);
    }
  });
  return problems.length > 0 ? 1 : 0;
}

/**
 * Claude writes .claude.json.tmp.<pid>.<rand> while saving and removes it on
 * success. Survivors mean a crash mid-save, and they are worth flagging because
 * they hold a full copy of the registry. They sit next to the file, which for
 * the default profile is in ~, not ~/.claude.
 */
async function strayRegistryTemp(registryPath: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const dir = dirname(registryPath);
  try {
    const names = await readdir(dir);
    const stray = names.filter((n) => n.startsWith(`${basename(registryPath)}.tmp.`));
    return (await Promise.all(stray.map(async (n) => ((await exists(join(dir, n))) ? n : null)))).filter(
      (n): n is string => n !== null,
    );
  } catch {
    return [];
  }
}

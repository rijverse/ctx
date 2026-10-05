import type { Plan, Profile } from "../types.js";
import { apply, warnCollisions } from "../core/apply.js";
import { liveSessions } from "../core/live.js";
import { planDetach, planSync } from "../core/plan.js";
import { storeLockPath, tilde } from "../core/paths.js";
import { listProfiles, selectProfiles } from "../core/profiles.js";
import { push } from "../core/session.js";
import type { Parsed } from "../util/args.js";
import { withLock } from "../util/lock.js";
import { bold, confirm, CtxError, cyan, dim, green, out, pad, yellow } from "../util/ui.js";
import { context, type Ctx } from "./_context.js";

export async function sync(args: Parsed): Promise<number> {
  return run(args, "sync");
}

export async function detach(args: Parsed): Promise<number> {
  return run(args, "detach");
}

async function run(args: Parsed, mode: "sync" | "detach"): Promise<number> {
  const ctx = await context(args);
  const all = await listProfiles(ctx.config, ctx.store);
  const seed = ctx.config.seed;
  // The seed goes first, so its copies are the ones the store keeps.
  const wanted = (args.flags.has("all") ? all : selectProfiles(all, args.positionals)).sort(
    (a, b) => Number(b.name === seed) - Number(a.name === seed),
  );

  if (wanted.length === 0) {
    out(yellow("No profiles selected. Name one, or pass --all."));
    return 1;
  }

  // Profiles are folded in one after another, so planning has to account for
  // what the earlier ones will have put in the store.
  const pending = new Set<string>();
  const plans = new Map<Profile, Plan>();
  for (const p of wanted) {
    plans.set(
      p,
      mode === "sync"
        ? await planSync(p, ctx.store, ctx.config, ctx.only, pending)
        : await planDetach(p, ctx.store, ctx.config, ctx.only),
    );
  }

  // Moving a directory out from under a live session can race its writes, so
  // profiles with claude running are refused unless --force says otherwise.
  const running = new Map<Profile, number[]>();
  for (const [p, plan] of plans) {
    if (plan.effective.length === 0) continue;
    const pids = await liveSessions(p);
    if (pids.length > 0) running.set(p, pids);
  }

  const total = [...plans.values()].reduce((n, p) => n + p.effective.length, 0);
  if (ctx.json) {
    out(JSON.stringify({ mode, store: ctx.store, plans: serialize(plans, running) }, null, 2));
    return 0;
  }

  printPlan(plans, running, mode, ctx);
  if (total === 0) {
    out(green(mode === "sync" ? "Everything is already linked." : "Nothing is linked."));
    return 0;
  }
  const force = args.flags.has("force");
  const overrides = mode === "sync" ? await seedOverrides(all, wanted, plans, ctx) : [];
  if (overrides.length > 0) {
    out(yellow(`${seed} seeds the store but is not synced yet, so these would replace its copies: ${overrides.join(", ")}.`));
    if (!force && !ctx.dryRun) {
      out(dim(`Sync ${seed} first (\`ctx sync ${seed}\`), include it in this run, or pass --force.`));
      return 1;
    }
  }
  if (running.size > 0) {
    const names = [...running].map(([p, pids]) => `${p.name} (pid ${pids.join(", ")})`).join(", ");
    out(yellow(`claude is running in ${names}.`));
    if (!force && !ctx.dryRun) {
      out(dim("Close those sessions and run this again, or pass --force to go ahead anyway."));
      return 1;
    }
  }
  if (ctx.dryRun) {
    out(dim("--dry-run: nothing was changed."));
    return 0;
  }
  if (!ctx.yes && !(await confirm(`Apply ${total} change(s)?`))) {
    out(yellow("Cancelled. Nothing was changed."));
    return 1;
  }

  out();
  await withLock(storeLockPath(ctx.store), async () => {
    for (const [profile] of plans) {
      // Re-plan against the store as it actually is now: earlier profiles in
      // this same run have already changed it.
      const plan =
        mode === "sync"
          ? await planSync(profile, ctx.store, ctx.config, ctx.only)
          : await planDetach(profile, ctx.store, ctx.config, ctx.only);
      if (plan.effective.length === 0) continue;
      const result = await apply(plan, ctx.store, ctx.config, { verbose: ctx.verbose });
      out(`${green("ok")} ${pad(profile.name, 12)} ${result.done} change(s)`);
      warnCollisions(result);
      if (result.backups.length > 0) {
        out(dim(`  backed up to ${tilde(result.backups[0]!.replace(/\/[^/]+$/, ""))}`));
      }
      if (mode === "sync") await foldRegistry(profile, ctx);
    }
  });

  out();
  out(green("Done."));
  if (mode === "sync") out(dim("Run `ctx status` to confirm, `ctx detach <profile>` to undo."));
  return 0;
}

/**
 * Items another profile would seed into the store while the seed profile, left
 * out of this run, still holds its own copy. Those would win over the seed's.
 */
async function seedOverrides(
  all: Profile[],
  wanted: Profile[],
  plans: Map<Profile, Plan>,
  ctx: Ctx,
): Promise<string[]> {
  const seed = all.find((p) => p.name === ctx.config.seed);
  if (seed === undefined || wanted.includes(seed)) return [];
  const own = (await planSync(seed, ctx.store, ctx.config, ctx.only)).steps
    .filter((s) => s.state === "dir" || s.state === "file")
    .map((s) => s.item.name);
  const seeded = [...plans.values()].flatMap((p) => p.effective.filter((s) => s.kind === "seed").map((s) => s.item.name));
  return [...new Set(seeded.filter((name) => own.includes(name)))];
}

/** A broken .claude.json must not abort a sync whose files already moved. */
async function foldRegistry(profile: Profile, ctx: Ctx): Promise<void> {
  try {
    const folded = await push(profile, ctx.store, ctx.config);
    if (folded.reset) {
      out(yellow(`  ${tilde(profile.registryPath)} looks reset, so it was not folded in. \`ctx registry pull ${profile.name}\` restores it.`));
    } else if (folded.keys > 0) {
      out(dim(`  folded .claude.json into the store, ${folded.keys} shared key(s)`));
    }
  } catch (e) {
    if (!(e instanceof CtxError)) throw e;
    out(yellow(`  .claude.json skipped: ${e.message}`));
  }
}

function printPlan(plans: Map<Profile, Plan>, running: Map<Profile, number[]>, mode: string, ctx: Ctx): void {
  out();
  out(`${bold(mode === "sync" ? "Plan" : "Detach plan")}  ${dim("store")} ${cyan(tilde(ctx.store))}`);

  for (const [profile, plan] of plans) {
    out();
    const live = running.get(profile);
    const note = live === undefined ? "" : `  ${yellow(`claude running (${live.length})`)}`;
    out(`  ${bold(profile.name)} ${dim(tilde(profile.dir))}${note}`);
    if (plan.effective.length === 0) {
      out(dim("    nothing to do"));
      continue;
    }
    for (const step of plan.effective) {
      out(
        `    ${pad(verb(step.kind), 9)} ${pad(step.item.name, 18)} ${dim(step.detail ?? "")}`.trimEnd(),
      );
    }
  }
  out();
}

function verb(kind: string): string {
  switch (kind) {
    case "seed":
      return green("seed");
    case "absorb":
      return yellow("absorb");
    case "stash":
      return yellow("stash");
    case "attach":
      return green("attach");
    case "relink":
      return yellow("relink");
    case "detach":
      return cyan("detach");
    default:
      return dim(kind);
  }
}

function serialize(plans: Map<Profile, Plan>, running: Map<Profile, number[]>) {
  return [...plans].map(([profile, plan]) => ({
    profile: profile.name,
    dir: profile.dir,
    running: running.get(profile) ?? [],
    steps: plan.effective.map((s) => ({
      item: s.item.name,
      state: s.state,
      action: s.kind,
      from: s.from,
      to: s.to,
      detail: s.detail,
    })),
  }));
}

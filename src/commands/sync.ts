import type { Plan, Profile } from "../types.js";
import { apply, warnCollisions } from "../core/apply.js";
import { findRunning, stopRunning, type Running } from "../core/live.js";
import { heldBySeed, planDetach, planSync } from "../core/plan.js";
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

  // Left out of the run, an unsynced seed would see another profile's copies
  // win over its own. Rather than refuse, it goes first.
  const seedProfile = all.find((p) => p.name === seed);
  if (mode === "sync" && seedProfile !== undefined && !wanted.includes(seedProfile)) {
    const clash = await seedClashes(seedProfile, wanted, ctx);
    if (clash.length > 0) {
      out(yellow(`${seed} seeds the store and is not synced yet, so it is synced first. Otherwise ${clash.join(", ")} would replace its copies.`));
      wanted.unshift(seedProfile);
    }
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
  // claude is stopped in every profile this run changes, once you confirm.
  const running = await findRunning([...plans].filter(([, plan]) => plan.effective.length > 0).map(([p]) => p));

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
  const stopping = running.filter((r) => !r.self);
  if (stopping.length > 0) out(yellow(`claude will be stopped in ${describeRunning(stopping)} before anything moves.`));
  if (ctx.dryRun) {
    out(dim("--dry-run: nothing was changed."));
    return 0;
  }
  if (!ctx.yes && !(await confirm(`Apply ${total} change(s)?`))) {
    out(yellow("Cancelled. Nothing was changed."));
    return 1;
  }
  await stopSessions(running);

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
    if (mode === "sync") await linkLate([...plans.keys()], ctx);
  });

  out();
  out(green("Done."));
  if (mode === "sync") out(dim("Run `ctx status` to confirm, `ctx detach <profile>` to undo."));
  return 0;
}

function describeRunning(running: Running[]): string {
  return running.map((r) => `${r.profile.name} (pid ${r.pid}${r.cwd === undefined ? "" : `, ${tilde(r.cwd)}`})`).join(", ");
}

/**
 * Stop the claude sessions in the profiles this run changes, and say so. The
 * one ctx runs from cannot be stopped without stopping ctx, so it keeps going.
 */
async function stopSessions(running: Running[]): Promise<void> {
  const others = running.filter((r) => !r.self);
  for (const r of running.filter((r) => r.self)) {
    out(yellow(`warning: claude in ${r.profile.name} (pid ${r.pid}) is the session running ctx, so it keeps running. Restart it once this finishes.`));
  }
  if (others.length === 0) return;
  out(yellow(`warning: stopping claude in ${describeRunning(others)}.`));
  const left = await stopRunning(others);
  out(dim("  Their transcripts are saved. `claude --continue` in that folder picks a session up again."));
  if (left.length > 0) out(yellow(`warning: ${describeRunning(left)} would not stop. Carrying on anyway.`));
}

/** Items the profiles in this run would seed while the seed still holds its own copy. */
async function seedClashes(seed: Profile, wanted: Profile[], ctx: Ctx): Promise<string[]> {
  const held = await heldBySeed(seed, ctx.store, ctx.config, ctx.only);
  const pending = new Set<string>();
  const clash = new Set<string>();
  for (const p of wanted) {
    const plan = await planSync(p, ctx.store, ctx.config, ctx.only, pending);
    for (const s of plan.effective) if (s.kind === "seed" && held.has(s.item.name)) clash.add(s.item.name);
  }
  return [...clash];
}

/**
 * A profile synced early in a run cannot link what a later one brought into
 * the store, plans from the third profile, say. One more pass attaches those.
 */
async function linkLate(profiles: Profile[], ctx: Ctx): Promise<void> {
  for (const profile of profiles) {
    const late = (await planSync(profile, ctx.store, ctx.config, ctx.only)).effective.filter((s) => s.kind === "attach");
    if (late.length === 0) continue;
    await apply({ steps: late, effective: late }, ctx.store, ctx.config, { verbose: ctx.verbose });
    out(`${green("ok")} ${pad(profile.name, 12)} also linked ${late.map((s) => s.item.name).join(", ")}`);
  }
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

function printPlan(plans: Map<Profile, Plan>, running: Running[], mode: string, ctx: Ctx): void {
  out();
  out(`${bold(mode === "sync" ? "Plan" : "Detach plan")}  ${dim("store")} ${cyan(tilde(ctx.store))}`);

  for (const [profile, plan] of plans) {
    out();
    const live = running.filter((r) => r.profile === profile);
    const stopped = live.filter((r) => !r.self).length;
    const note =
      live.length === 0
        ? ""
        : `  ${yellow(stopped > 0 ? `claude running (${stopped}), will be stopped` : "claude running here, left alone")}`;
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

function serialize(plans: Map<Profile, Plan>, running: Running[]) {
  return [...plans].map(([profile, plan]) => ({
    profile: profile.name,
    dir: profile.dir,
    running: running.filter((r) => r.profile === profile).map((r) => r.pid),
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

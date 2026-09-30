import type { Plan, Profile } from "../types.js";
import { apply, warnCollisions } from "../core/apply.js";
import { planDetach, planSync } from "../core/plan.js";
import { tilde } from "../core/paths.js";
import { listProfiles, selectProfiles } from "../core/profiles.js";
import { push } from "../core/session.js";
import type { Parsed } from "../util/args.js";
import { bold, confirm, cyan, dim, green, out, pad, yellow } from "../util/ui.js";
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
  const wanted = args.flags.has("all") ? all : selectProfiles(all, args.positionals);

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

  const total = [...plans.values()].reduce((n, p) => n + p.effective.length, 0);
  if (ctx.json) {
    out(JSON.stringify({ mode, store: ctx.store, plans: serialize(plans) }, null, 2));
    return 0;
  }

  printPlan(plans, mode, ctx);
  if (total === 0) {
    out(green(mode === "sync" ? "Everything is already linked." : "Nothing is linked."));
    return 0;
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
  for (const [profile] of plans) {
    // Re-plan against the store as it actually is now: earlier profiles in this
    // same run have already changed it.
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
    if (mode === "sync") {
      const keys = await push(profile, ctx.store, ctx.config);
      if (keys > 0) out(dim(`  folded ${keys} .claude.json key(s) into the store`));
    }
  }

  out();
  out(green("Done."));
  if (mode === "sync") out(dim("Run `ctx status` to confirm, `ctx detach <profile>` to undo."));
  return 0;
}

function printPlan(plans: Map<Profile, Plan>, mode: string, ctx: Ctx): void {
  out();
  out(`${bold(mode === "sync" ? "Plan" : "Detach plan")}  ${dim("store")} ${cyan(tilde(ctx.store))}`);

  for (const [profile, plan] of plans) {
    out();
    out(`  ${bold(profile.name)} ${dim(tilde(profile.dir))}`);
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

function serialize(plans: Map<Profile, Plan>) {
  return [...plans].map(([profile, plan]) => ({
    profile: profile.name,
    dir: profile.dir,
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

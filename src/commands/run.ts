import { spawn } from "node:child_process";
import { constants } from "node:os";
import type { Plan, Profile } from "../types.js";
import { apply } from "../core/apply.js";
import { saveConfig } from "../core/config.js";
import { liveSessions } from "../core/live.js";
import { heldBySeed, planSync } from "../core/plan.js";
import { storeLockPath, tilde } from "../core/paths.js";
import { listProfiles, resolveProfile } from "../core/profiles.js";
import { pull, push } from "../core/session.js";
import type { Parsed } from "../util/args.js";
import { ensureDir, exists } from "../util/fsx.js";
import { withLock } from "../util/lock.js";
import { CtxError, cyan, dim, fail, out, yellow } from "../util/ui.js";
import { context, type Ctx } from "./_context.js";

/**
 * Launch claude for a profile with the store's shared .claude.json keys in
 * place, then fold whatever the session changed back into the store.
 *
 * Bare `claude` still works untouched: the symlinked directories cover it. This
 * is only about the one file that cannot be symlinked, because half of it is
 * identity. `ctx hooks install` wires the same pull/push into bare `claude`.
 */
export async function runProfile(args: Parsed): Promise<number> {
  const ctx = await context(args);
  const name = args.positionals[0];
  if (name === undefined) fail("usage: ctx run <profile> [-- <claude args>]");

  const profile = await resolveProfile(name, ctx.config, ctx.store);
  if (!(await exists(profile.dir))) {
    out(`ctx: new profile ${cyan(profile.name)} at ${tilde(profile.dir)}. Log in when claude starts, or type /login.`);
  }
  await ensureDir(profile.dir);

  const managed = isManaged(await planSync(profile, ctx.store, ctx.config));
  if (managed) await link(profile, ctx, "attach");

  const left = (await planSync(profile, ctx.store, ctx.config)).effective.filter((s) => s.kind !== "seed" || !managed);
  // Said before and after: claude takes over the screen, so the first one is
  // easy to miss.
  const unsynced =
    left.length === 0
      ? undefined
      : `ctx: ${profile.name} is not synced into the store yet (${left.map((s) => s.item.name).join(", ")}), ` +
        "so it still sees only its own sessions, skills and settings. Close its claude sessions and run " +
        `\`ctx sync ${profile.name}\`, or \`ctx sync --all\` for every account.`;
  if (unsynced !== undefined) out(yellow(unsynced));

  // A .claude.json ctx cannot read is Claude's to recover, so the session
  // still starts, just without the shared keys this time.
  try {
    const pulled = await pull(profile, ctx.store, ctx.config);
    if (pulled.reset) out(yellow(`ctx: ${tilde(profile.registryPath)} looked reset, so it was restored from the store.`));
    if (ctx.verbose) out(dim(`ctx: ${pulled.keys} shared key(s) into ${tilde(profile.registryPath)}`));
  } catch (e) {
    if (!(e instanceof CtxError)) throw e;
    out(yellow(`ctx: skipped the registry pull: ${e.message}`));
  }
  if (ctx.verbose) out(dim(`ctx: CLAUDE_CONFIG_DIR=${tilde(profile.dir)}`));

  const code = await launch(profile.dir, args.passthrough);
  if (unsynced !== undefined) out(yellow(unsynced));

  // A new profile has just written its first sessions, history and settings
  // as real files. Whatever the store has no copy of yet goes in now.
  if (managed && (await liveSessions(profile)).length === 0) await link(profile, ctx, "seed");

  try {
    const merged = await push(profile, ctx.store, ctx.config);
    if (ctx.verbose) out(dim(`ctx: folded the session back, store holds ${merged.keys} shared key(s)`));
  } catch (e) {
    if (!(e instanceof CtxError)) throw e;
    out(yellow(`ctx: could not fold the session back: ${e.message}`));
  }

  return code;
}

/**
 * A profile ctx may link on its own: one that is already linked to the store,
 * or a new one with nothing of its own yet. One detached on purpose, holding
 * real copies and no links, is left alone.
 */
function isManaged(plan: Plan): boolean {
  if (plan.steps.some((s) => s.state === "linked")) return true;
  return !plan.steps.some((s) => s.state === "dir" || s.state === "file");
}

/**
 * Apply only the steps that cannot displace anything: "attach" links what the
 * store has and the profile lacks, "seed" moves what the profile has into an
 * empty store slot. Items the seed profile still holds are not seeded by
 * anyone else, the same rule `ctx sync` keeps.
 */
async function link(profile: Profile, ctx: Ctx, kind: "attach" | "seed"): Promise<void> {
  await withLock(storeLockPath(ctx.store), async () => {
    const plan = await planSync(profile, ctx.store, ctx.config);
    let steps = plan.effective.filter((s) => s.kind === kind);
    if (kind === "seed" && profile.name !== ctx.config.seed) {
      const seed = (await listProfiles(ctx.config, ctx.store)).find((p) => p.name === ctx.config.seed);
      const held = await heldBySeed(seed, ctx.store, ctx.config);
      steps = steps.filter((s) => !held.has(s.item.name));
    }
    if (steps.length === 0) return;
    await apply({ steps, effective: steps }, ctx.store, ctx.config);
    // A store started empty takes its seed from whoever filled it first.
    if (kind === "seed" && ctx.config.seed === undefined) {
      await saveConfig(ctx.store, { ...ctx.config, seed: profile.name });
    }
    const what = steps.map((s) => s.item.name).join(", ");
    out(dim(kind === "attach" ? `ctx: linked ${what} from the store` : `ctx: moved ${what} into the store and linked them`));
  });
}

function launch(configDir: string, argv: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("claude", argv, {
      stdio: "inherit",
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    });
    child.on("error", (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        out(yellow("claude is not on your PATH."));
        resolve(127);
        return;
      }
      out(yellow(`could not launch claude: ${e.message}`));
      resolve(1);
    });
    // The terminal already sends SIGINT and SIGHUP to claude, which shares our
    // process group, so forwarding them would deliver each one twice. They are
    // only caught so ctx outlives claude and can fold the session back.
    // SIGTERM is usually aimed at ctx alone, so that one is passed on.
    const stay = () => {};
    const onTerm = () => child.kill("SIGTERM");
    process.on("SIGINT", stay);
    process.on("SIGHUP", stay);
    process.on("SIGTERM", onTerm);
    child.on("close", (code, signal) => {
      process.off("SIGINT", stay);
      process.off("SIGHUP", stay);
      process.off("SIGTERM", onTerm);
      resolve(signal !== null ? 128 + (constants.signals[signal] ?? 0) : (code ?? 0));
    });
  });
}

/** `ctx which <profile>` prints the env a shell would need. Handy in scripts. */
export async function which(args: Parsed): Promise<number> {
  const ctx = await context(args);
  const name = args.positionals[0] ?? "default";
  const profile = await resolveProfile(name, ctx.config, ctx.store);
  out(`export CLAUDE_CONFIG_DIR=${profile.dir}`);
  if (ctx.verbose) out(dim(`# registry: ${cyan(profile.registryPath)}`));
  return 0;
}

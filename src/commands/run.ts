import { spawn } from "node:child_process";
import { constants } from "node:os";
import { planSync } from "../core/plan.js";
import { tilde } from "../core/paths.js";
import { resolveProfile } from "../core/profiles.js";
import { pull, push } from "../core/session.js";
import type { Parsed } from "../util/args.js";
import { ensureDir } from "../util/fsx.js";
import { CtxError, cyan, dim, fail, out, yellow } from "../util/ui.js";
import { context } from "./_context.js";

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
  await ensureDir(profile.dir);

  const plan = await planSync(profile, ctx.store, ctx.config);
  const unlinked = plan.effective.filter((s) => s.kind !== "keep");
  if (unlinked.length > 0) {
    out(
      yellow(
        `${profile.name} has ${unlinked.length} item(s) not linked to the store. Run \`ctx sync ${profile.name}\`.`,
      ),
    );
  }

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

  try {
    const merged = await push(profile, ctx.store, ctx.config);
    if (ctx.verbose) out(dim(`ctx: folded the session back, store holds ${merged.keys} shared key(s)`));
  } catch (e) {
    if (!(e instanceof CtxError)) throw e;
    out(yellow(`ctx: could not fold the session back: ${e.message}`));
  }

  return code;
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

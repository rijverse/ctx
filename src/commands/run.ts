import { spawn } from "node:child_process";
import { planSync } from "../core/plan.js";
import { tilde } from "../core/paths.js";
import { resolveProfile } from "../core/profiles.js";
import { pull, push } from "../core/session.js";
import type { Parsed } from "../util/args.js";
import { ensureDir } from "../util/fsx.js";
import { cyan, dim, fail, out, yellow } from "../util/ui.js";
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

  const pulled = await pull(profile, ctx.store, ctx.config);
  if (ctx.verbose) {
    out(dim(`ctx: ${pulled} shared key(s) into ${tilde(profile.registryPath)}`));
    out(dim(`ctx: CLAUDE_CONFIG_DIR=${tilde(profile.dir)}`));
  }

  const code = await launch(profile.dir, args.passthrough);

  const merged = await push(profile, ctx.store, ctx.config);
  if (ctx.verbose) out(dim(`ctx: merged ${merged} key(s) back into the store`));

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
    // Let claude own the terminal: forward signals rather than dying first.
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    child.on("close", (code, signal) => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(signal !== null ? 128 : (code ?? 0));
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

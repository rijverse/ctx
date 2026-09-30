import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { profileFromDir, tilde } from "../core/paths.js";
import { push } from "../core/session.js";
import type { Parsed } from "../util/args.js";
import { copyInto, exists, readJson, writeJson } from "../util/fsx.js";
import { bold, confirm, cyan, dim, fail, green, out, yellow } from "../util/ui.js";
import { context } from "./_context.js";

const MARKER = "ctx registry push";

interface HookEntry {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

function selfCommand(): string {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  return `node ${JSON.stringify(cli)} hook end`;
}

/**
 * Wire the store into sessions that were not started by `ctx run`.
 *
 * Only the push half is hookable. SessionStart fires after Claude has already
 * read .claude.json, so pulling there would be overwritten by Claude's own next
 * save; pulling stays the job of `ctx run`. Pushing at SessionEnd is enough to
 * keep the store complete whichever way you launched.
 */
export async function hooks(args: Parsed): Promise<number> {
  const ctx = await context(args);
  const action = args.positionals[0] ?? "status";
  const settingsPath = join(ctx.store, "settings.json");

  const settings = (await readJson<Settings>(settingsPath)) ?? {};
  const groups = settings.hooks?.["SessionEnd"] ?? [];
  const installed = groups.some((g) => g.hooks.some((h) => h.command.includes(MARKER) || h.command.includes("hook end")));

  if (action === "status") {
    out();
    out(`${bold("SessionEnd hook")}  ${installed ? green("installed") : dim("not installed")}`);
    out(dim(`  in ${tilde(settingsPath)}`));
    out();
    out(dim("  Installed, every claude session folds its .claude.json changes into"));
    out(dim("  the store on exit, however it was launched. Pulling still needs"));
    out(dim("  `ctx run <profile>`, because SessionStart fires too late to help."));
    out();
    return 0;
  }

  if (action === "install") {
    if (installed) {
      out(green("Already installed."));
      return 0;
    }
    out();
    out(`This adds a ${cyan("SessionEnd")} hook to ${cyan(tilde(settingsPath))}:`);
    out(dim(`  ${selfCommand()}`));
    out(dim("  Shared settings, so it applies to every profile."));
    out();
    if (ctx.dryRun) {
      out(dim("--dry-run: nothing was changed."));
      return 0;
    }
    if (!ctx.yes && !(await confirm("Install it?"))) {
      out(yellow("Cancelled. Nothing was changed."));
      return 1;
    }

    const backed = await exists(settingsPath);
    if (backed) await copyInto(settingsPath, `${settingsPath}.ctx-bak`);

    const next: Settings = { ...settings };
    next.hooks = { ...(settings.hooks ?? {}) };
    next.hooks["SessionEnd"] = [...groups, { hooks: [{ type: "command", command: selfCommand() }] }];
    await writeJson(settingsPath, next);

    out(green("Installed."));
    if (backed) out(dim(`  previous settings kept at ${tilde(settingsPath)}.ctx-bak`));
    return 0;
  }

  if (action === "uninstall") {
    if (!installed) {
      out("Not installed.");
      return 0;
    }
    if (ctx.dryRun) {
      out(dim("--dry-run: nothing was changed."));
      return 0;
    }
    const next: Settings = { ...settings };
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !h.command.includes("hook end")) }))
      .filter((g) => g.hooks.length > 0);
    next.hooks = { ...(settings.hooks ?? {}) };
    if (kept.length > 0) next.hooks["SessionEnd"] = kept;
    else delete next.hooks["SessionEnd"];
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
    await writeJson(settingsPath, next);
    out(green("Removed."));
    return 0;
  }

  fail(`unknown hooks action "${action}". Use status, install or uninstall.`);
}

/**
 * The hook body itself. Claude runs it with CLAUDE_CONFIG_DIR set to whichever
 * profile the session belongs to, so it needs no arguments. It stays quiet and
 * always exits 0: a failure here must never take a session down with it.
 */
export async function hookEnd(args: Parsed): Promise<number> {
  try {
    const ctx = await context(args);
    const dir = process.env["CLAUDE_CONFIG_DIR"] ?? join(process.env["HOME"] ?? "", ".claude");
    await push(profileFromDir(dir), ctx.store, ctx.config);
  } catch {
    /* never fail a session over bookkeeping */
  }
  return 0;
}

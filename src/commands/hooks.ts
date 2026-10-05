import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { stateOf } from "../core/plan.js";
import { DEFAULT_STORE, expand, home, profileFromDir, tilde } from "../core/paths.js";
import { listProfiles } from "../core/profiles.js";
import { push } from "../core/session.js";
import type { Parsed } from "../util/args.js";
import { copyInto, exists, readJson, writeJson } from "../util/fsx.js";
import { bold, confirm, cyan, dim, fail, green, out, yellow } from "../util/ui.js";
import { context, type Ctx } from "./_context.js";

interface HookEntry {
  type?: unknown;
  command?: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}
type Settings = Record<string, unknown> & { hooks?: Record<string, unknown> };

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function selfCommand(store: string): string {
  const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
  const custom = store === join(home(), DEFAULT_STORE) ? "" : ` --store ${quote(store)}`;
  return `node ${quote(cli)} hook end${custom}`;
}

/**
 * Recognise a hook this tool wrote, whichever path it was installed from, and
 * nothing else: a user's own hook that happens to say "hook end" stays put.
 * "ctx registry push" is what earlier builds installed.
 */
function isOurs(h: HookEntry): boolean {
  if (typeof h?.command !== "string") return false;
  return /(?:^|[\s"'/])(?:cli\.js|ctx)["']?\s+hook\s+end(?:\s|$)/.test(h.command) || h.command.includes("ctx registry push");
}

function sessionEndGroups(settings: Settings): HookGroup[] {
  const groups = settings.hooks?.["SessionEnd"];
  return Array.isArray(groups) ? (groups as HookGroup[]) : [];
}

const hasOurs = (g: HookGroup) => Array.isArray(g?.hooks) && g.hooks.some(isOurs);

/** How many profiles actually load the store's settings.json, which is where the hook lives. */
async function reach(ctx: Ctx): Promise<{ linked: number; total: number }> {
  const profiles = await listProfiles(ctx.config, ctx.store);
  let linked = 0;
  for (const p of profiles) {
    if ((await stateOf(join(p.dir, "settings.json"), join(ctx.store, "settings.json"))) === "linked") linked++;
  }
  return { linked, total: profiles.length };
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
  const groups = sessionEndGroups(settings);
  const installed = groups.some(hasOurs);
  const command = selfCommand(ctx.store);
  const current = groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h) => h?.command === command));

  if (action === "status") {
    const { linked, total } = await reach(ctx);
    out();
    out(`${bold("SessionEnd hook")}  ${installed ? green("installed") : dim("not installed")}`);
    out(dim(`  in ${tilde(settingsPath)}, which ${linked} of ${total} profile(s) link to`));
    if (installed && !current) out(yellow(`  points at an older ctx path. \`ctx hooks install\` updates it.`));
    out();
    out(dim("  Installed, every claude session folds its .claude.json changes into"));
    out(dim("  the store on exit, however it was launched. Pulling still needs"));
    out(dim("  `ctx run <profile>`, because SessionStart fires too late to help."));
    out();
    return 0;
  }

  if (action === "install") {
    if (current) {
      out(green("Already installed."));
      return 0;
    }
    if (!ctx.config.shared.includes("settings.json")) {
      fail("settings.json is not shared, so a hook in the store's copy would never run. Add it to `shared` in ctx.json first.");
    }
    const { linked, total } = await reach(ctx);
    out();
    out(`This ${installed ? "updates the" : "adds a"} ${cyan("SessionEnd")} hook in ${cyan(tilde(settingsPath))}:`);
    out(dim(`  ${command}`));
    out(dim(`  Shared settings, so it reaches every profile linked to them (${linked} of ${total} now).`));
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
    next.hooks["SessionEnd"] = [...withoutOurs(groups), { hooks: [{ type: "command", command }] }];
    await writeJson(settingsPath, next);

    out(green(installed ? "Updated." : "Installed."));
    if (backed) out(dim(`  previous settings kept at ${tilde(settingsPath)}.ctx-bak`));
    if (linked < total) out(yellow(`  ${total - linked} profile(s) do not link settings.json yet. \`ctx sync --all\` links them.`));
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
    const kept = withoutOurs(groups);
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

/** Drop this tool's entries, and any group left empty by that. Other hooks are kept as they are. */
function withoutOurs(groups: HookGroup[]): HookGroup[] {
  return groups
    .map((g) => (hasOurs(g) ? { ...g, hooks: g.hooks!.filter((h) => !isOurs(h)) } : g))
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
}

/**
 * The hook body itself. Claude runs it with CLAUDE_CONFIG_DIR set to whichever
 * profile the session belongs to, so it needs no arguments. It stays quiet and
 * always exits 0: a failure here must never take a session down with it.
 */
export async function hookEnd(args: Parsed): Promise<number> {
  try {
    const ctx = await context(args);
    const dir = expand(process.env["CLAUDE_CONFIG_DIR"] ?? join(home(), ".claude"));
    // Look the dir up rather than deriving its name, which ctx.json may override.
    const known = (await listProfiles(ctx.config, ctx.store)).find((p) => p.dir === dir);
    await push(known ?? profileFromDir(dir), ctx.store, ctx.config);
  } catch {
    /* never fail a session over bookkeeping */
  }
  return 0;
}

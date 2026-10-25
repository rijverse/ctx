import { loadConfig } from "../core/config.js";
import { discover, listProfiles, selectProfiles } from "../core/profiles.js";
import { usageOf, type AccountUsage, type Limit } from "../core/usage.js";
import type { Parsed } from "../util/args.js";
import { bold, dim, green, out, pad, progress, red, yellow } from "../util/ui.js";
import { globals } from "./_context.js";

/**
 * How much of each account's plan limits is left, the numbers Claude's /usage
 * shows, for every profile at once. Nothing here needs the store, so it works
 * before `ctx init` too.
 */
export async function planUsage(args: Parsed): Promise<number> {
  const g = globals(args);
  const config = await loadConfig(g.store);
  const all = config === undefined ? await discover(g.store) : await listProfiles(config, g.store);
  const profiles = selectProfiles(all, args.positionals);
  if (profiles.length === 0) {
    out(yellow("No Claude profiles found."));
    return 1;
  }

  const asking = g.json ? undefined : progress("asking Anthropic");
  asking?.update();
  let answered = 0;
  const now = Date.now();
  const rows = await Promise.all(
    profiles.map(async (p) => {
      const row = await usageOf(p, now);
      asking?.update(`${++answered}/${profiles.length}`);
      return row;
    }),
  );
  asking?.done();
  const code = rows.some((r) => r.usage.state === "error") ? 1 : 0;

  if (g.json) {
    out(
      JSON.stringify(
        {
          profiles: rows.map((r) => ({
            name: r.profile.name,
            dir: r.profile.dir,
            account: r.account ?? null,
            plan: r.plan ?? null,
            ...r.usage,
          })),
        },
        null,
        2,
      ),
    );
    return code;
  }

  const nameWidth = Math.max(...rows.map((r) => r.profile.name.length), 7) + 2;
  const accountWidth = Math.max(...rows.map((r) => (r.account ?? "-").length), 7) + 2;
  const planWidth = Math.max(...rows.map((r) => (r.plan ?? "-").length), 4) + 2;
  const cellWidth = 16;

  out();
  out(
    `  ${pad(dim("profile"), nameWidth)}${pad(dim("account"), accountWidth)}${pad(dim("plan"), planWidth)}` +
      `${pad(dim("session"), cellWidth)}${dim("week")}`,
  );
  for (const r of rows) {
    const head = `  ${pad(bold(r.profile.name), nameWidth)}${pad(r.account ?? dim("-"), accountWidth)}${pad(r.plan ?? dim("-"), planWidth)}`;
    out((head + cells(r, now, cellWidth)).trimEnd());
  }
  out();
  out(dim("  percent of each limit left, then the time until it resets"));
  out();
  return code;
}

function cells(r: AccountUsage, now: number, cellWidth: number): string {
  const u = r.usage;
  switch (u.state) {
    case "ok": {
      const find = (label: string) => u.limits.find((l) => l.label === label);
      const rest = u.limits.filter((l) => l.label !== "session" && l.label !== "week");
      return (
        pad(cell(find("session"), now), cellWidth) +
        pad(cell(find("week"), now), cellWidth) +
        rest.map((l) => `${l.label} ${left(l)}`).join("  ")
      );
    }
    case "none":
      return dim("not logged in");
    case "expired":
      return yellow("login expired, claude renews it the next time it runs here");
    case "keychain":
      return dim("login is in the macOS keychain, which ctx does not read");
    case "error":
      return red(u.message);
  }
}

function cell(l: Limit | undefined, now: number): string {
  if (l === undefined) return dim("   -");
  // Right-aligned, so 9% and 100% line up across rows.
  const text = " ".repeat(Math.max(0, 4 - `${remaining(l)}%`.length)) + left(l);
  return l.resetsAt === undefined ? text : `${text}  ${dim(until(l.resetsAt, now))}`;
}

function remaining(l: Limit): number {
  return Math.max(0, Math.round(100 - l.used));
}

function left(l: Limit): string {
  const n = remaining(l);
  return (n === 0 ? red : n < 25 ? yellow : green)(`${n}%`);
}

function until(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

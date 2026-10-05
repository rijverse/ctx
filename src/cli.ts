#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { add } from "./commands/add.js";
import { doctor } from "./commands/doctor.js";
import { hookEnd, hooks } from "./commands/hooks.js";
import { init } from "./commands/init.js";
import { registry } from "./commands/registry.js";
import { runProfile, which } from "./commands/run.js";
import { status } from "./commands/status.js";
import { detach, sync } from "./commands/sync.js";
import { parseArgs, type Parsed } from "./util/args.js";
import { bold, CtxError, dim, err, out, red, silenceBrokenPipe } from "./util/ui.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

type Handler = (args: Parsed) => Promise<number>;

const COMMANDS: Record<string, Handler> = {
  init,
  add,
  status,
  sync,
  detach,
  doctor,
  run: runProfile,
  which,
  registry,
  hooks,
  hook: hookInner,
};

const ALIASES: Record<string, string> = { ls: "status", st: "status", repair: "doctor" };

async function hookInner(args: Parsed): Promise<number> {
  if (args.positionals[0] === "end") return hookEnd(args);
  return 0;
}

function usage(): void {
  out();
  out(`${bold("ctx")} ${dim(VERSION)}  one source of truth for every Claude account on this machine`);
  out();
  out(bold("Commands"));
  out(`  init [--from P] [--add D,..] create the store and choose what it owns`);
  out(`  add <dir>... [--as name]    manage a profile dir outside ~/.claude-*, or rename one`);
  out(`  sync [profile...] [--all]   move a profile's data into the store and symlink it back`);
  out(`  status                      what every profile shares, and what it does not`);
  out(`  run <profile> [-- args]     launch claude for a profile with the shared registry`);
  out(`  detach [profile...]         hand a profile back its own independent copies`);
  out(`  doctor [profile...]         find and repair broken links`);
  out(`  registry <show|pull|push|diff> [profile]`);
  out(`                              the .claude.json split: shared context, private identity`);
  out(`  hooks <status|install|uninstall>`);
  out(`                              fold sessions you did not start with \`ctx run\` into the store`);
  out(`  which [profile]             print the CLAUDE_CONFIG_DIR export for a profile`);
  out();
  out(bold("Flags"));
  out(`  -n, --dry-run   print the plan, change nothing`);
  out(`  -y, --yes       do not ask`);
  out(`  -v, --verbose   name every path as it moves`);
  out(`      --json      machine-readable output`);
  out(`      --only a,b  restrict to these items`);
  out(`      --store P   use a different store (default ~/.ctx-store)`);
  out(`      --force     sync or detach even while claude is running there`);
  out();
  out(dim("  Identity is never shared. .credentials.json, entitlements and oauthAccount"));
  out(dim("  stay with the profile that owns them."));
  out();
}

async function main(): Promise<number> {
  silenceBrokenPipe();
  const args = parseArgs(process.argv.slice(2));
  const name = args.command;

  if (name === undefined || name === "help" || args.flags.has("help") || args.flags.has("h")) {
    usage();
    return name === undefined ? 1 : 0;
  }
  if (name === "version" || args.flags.has("version")) {
    out(VERSION);
    return 0;
  }

  const handler = COMMANDS[ALIASES[name] ?? name];
  if (handler === undefined) {
    err(`${red("unknown command")} "${name}"`);
    err(dim("Run `ctx help` for the list."));
    return 1;
  }

  return handler(args);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    if (e instanceof CtxError) {
      err(`${red("ctx:")} ${e.message}`);
      process.exitCode = 1;
      return;
    }
    err(`${red("ctx:")} ${e instanceof Error ? e.message : String(e)}`);
    if (process.env["CTX_DEBUG"] !== undefined && e instanceof Error) err(e.stack ?? "");
    process.exitCode = 1;
  });

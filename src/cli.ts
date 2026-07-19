#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import chalk from "chalk";
import type { GlobalOpts } from "./commands/_util.js";
import { accountsCommand } from "./commands/accounts.js";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { linkCommand } from "./commands/link.js";
import { unlinkCommand } from "./commands/unlink.js";
import { repairCommand } from "./commands/repair.js";
import { runCommand } from "./commands/run.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let version = "0.0.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8")
  ) as { version?: string };
  if (pkg.version) version = pkg.version;
} catch {
  // running from an odd layout; version stays 0.0.0
}

function globals(cmd: Command): GlobalOpts {
  const o = cmd.optsWithGlobals() as Record<string, unknown>;
  return {
    dryRun: o.dryRun as boolean | undefined,
    yes: o.yes as boolean | undefined,
    json: o.json as boolean | undefined,
    verbose: o.verbose as boolean | undefined,
    config: o.config as string | undefined,
    store: o.store as string | undefined,
  };
}

// The common flags are registered on every command (and the root) so they work
// whether placed before or after the subcommand.
const addCommon = (c: Command): Command =>
  c
    .option("--dry-run", "show what would happen without changing anything")
    .option("-y, --yes", "skip confirmation prompts")
    .option("--json", "emit JSON where supported")
    .option("--verbose", "more detail")
    .option("--config <path>", "path to ctx.config.json")
    .option("--store <path>", "shared store directory");

const program = new Command();
program
  .name("ctx")
  .description("Manage Claude CLI accounts and share context across them")
  .version(version)
  .enablePositionalOptions();
addCommon(program);

addCommon(
  program
    .command("accounts")
    .alias("ls")
    .description("List Claude account dirs and their link status")
).action((_o: unknown, cmd: Command) => accountsCommand(globals(cmd)));

addCommon(
  program
    .command("init")
    .description("Create and seed the shared store, choosing what to sync")
    .option("--from <account>", "account to seed the store from")
).action((o: { from?: string }, cmd: Command) =>
  initCommand(globals(cmd), { from: o.from })
);

addCommon(
  program
    .command("status")
    .description("Show per-account, per-item link state")
    .argument("[account]", "limit to one account")
).action((account: string | undefined, _o: unknown, cmd: Command) =>
  statusCommand(globals(cmd), account)
);

addCommon(
  program
    .command("link")
    .description("Link an account's shared items into the store")
    .argument("[account]", "account name (or use --all)")
    .option("--all", "link every account")
    .option("--only <items...>", "limit to specific shared items")
    .option("--force", "overwrite diverged files (store wins)")
    .option("--no-backup", "do not back up replaced entries")
).action(
  (
    account: string | undefined,
    o: { all?: boolean; only?: string[]; force?: boolean; backup?: boolean },
    cmd: Command
  ) =>
    linkCommand(globals(cmd), account, {
      all: o.all,
      only: o.only,
      force: o.force,
      backup: o.backup,
    })
);

addCommon(
  program
    .command("unlink")
    .description("Restore an account's independent copies from the store")
    .argument("[account]", "account name (or use --all)")
    .option("--all", "unlink every account")
    .option("--only <items...>", "limit to specific shared items")
).action(
  (
    account: string | undefined,
    o: { all?: boolean; only?: string[] },
    cmd: Command
  ) => unlinkCommand(globals(cmd), account, { all: o.all, only: o.only })
);

addCommon(
  program
    .command("repair")
    .description("Fix broken or wrong-target symlinks")
    .argument("[account]", "account name (or use --all)")
    .option("--all", "repair every account")
).action((account: string | undefined, o: { all?: boolean }, cmd: Command) =>
  repairCommand(globals(cmd), account, { all: o.all })
);

// run passes everything after the account through to claude, so it keeps the
// common flags off itself (place them before `run`, e.g. `ctx --store X run …`).
program
  .command("run")
  .description("Launch claude for an account (sets CLAUDE_CONFIG_DIR)")
  .argument("<account>", "account name")
  .argument("[claudeArgs...]", "arguments passed through to claude")
  .passThroughOptions()
  .action((account: string, claudeArgs: string[], _o: unknown, cmd: Command) =>
    runCommand(globals(cmd), account, claudeArgs ?? [])
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) process.exit(err.exitCode);
  const msg = err instanceof Error ? err.message : String(err);
  console.error(chalk.red(msg));
  process.exit(1);
});

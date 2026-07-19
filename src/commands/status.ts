import chalk from "chalk";
import type { PlannedAction } from "../types.js";
import { type GlobalOpts, fail, loadFromGlobals, out } from "./_util.js";
import { discoverAccounts } from "../core/accounts.js";
import { planLink } from "../core/plan.js";

export async function statusCommand(
  g: GlobalOpts,
  accountArg?: string
): Promise<void> {
  const config = await loadFromGlobals(g);
  const all = await discoverAccounts(config);
  const accounts = accountArg ? all.filter((a) => a.name === accountArg) : all;
  if (accountArg && !accounts.length) {
    fail(`unknown account "${accountArg}"`);
    process.exitCode = 1;
    return;
  }

  let problems = 0;
  const report: { name: string; isDefault: boolean; actions: PlannedAction[] }[] = [];
  for (const a of accounts) {
    const actions = await planLink(config, a, config.sharedItems);
    report.push({ name: a.name, isDefault: a.isDefault, actions });
    for (const x of actions) {
      if (x.entryState === "BROKEN" || x.entryState === "WRONG_TARGET") problems++;
    }
  }

  if (g.json) {
    out(
      JSON.stringify(
        {
          store: config.storePath,
          accounts: report.map((r) => ({
            name: r.name,
            isDefault: r.isDefault,
            items: r.actions.map((x) => ({
              name: x.item.name,
              entryState: x.entryState,
              storeState: x.storeState,
              diverged: x.diverged ?? false,
            })),
          })),
        },
        null,
        2
      )
    );
    if (problems) process.exitCode = 1;
    return;
  }

  out(chalk.dim(`store: ${config.storePath}`));
  for (const r of report) {
    const label = r.isDefault ? `${r.name} ${chalk.dim("(default)")}` : r.name;
    out(chalk.bold(`\n${label}`));
    const rows = r.actions.filter(
      (x) => !(x.entryState === "ABSENT" && x.storeState === "STORE_ABSENT")
    );
    if (!rows.length) {
      out(chalk.dim("  (nothing shared yet)"));
      continue;
    }
    for (const x of rows) {
      const extra = x.diverged ? chalk.dim(" (differs)") : "";
      out(`  ${x.item.name.padEnd(16)} ${stateLabel(x)}${extra}`);
    }
  }
  if (problems) {
    out(chalk.red(`\n${problems} broken/wrong link(s). Run: ctx repair --all`));
    process.exitCode = 1;
  }
}

function stateLabel(x: PlannedAction): string {
  switch (x.entryState) {
    case "LINKED":
      return chalk.green("linked");
    case "REAL_DIR":
    case "REAL_FILE":
      return chalk.yellow("unlinked");
    case "WRONG_TARGET":
      return chalk.red("wrong-target");
    case "BROKEN":
      return chalk.red("broken");
    case "ABSENT":
      return x.storeState === "STORE_PRESENT"
        ? chalk.cyan("adoptable")
        : chalk.dim("absent");
  }
}

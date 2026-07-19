import chalk from "chalk";
import type { PlannedAction } from "../types.js";
import { type GlobalOpts, loadFromGlobals, out } from "./_util.js";
import { discoverAccounts } from "../core/accounts.js";
import { planLink } from "../core/plan.js";

export async function accountsCommand(g: GlobalOpts): Promise<void> {
  const config = await loadFromGlobals(g);
  const accounts = await discoverAccounts(config);

  if (g.json) {
    const rows = [];
    for (const a of accounts) {
      const actions = await planLink(config, a, config.sharedItems);
      rows.push({ name: a.name, dir: a.dir, isDefault: a.isDefault, ...tally(actions) });
    }
    out(JSON.stringify({ store: config.storePath, accounts: rows }, null, 2));
    return;
  }

  out(chalk.dim(`store: ${config.storePath}`));
  if (!accounts.length) {
    out(`No Claude account dirs found under ${config.accountsRoot}.`);
    return;
  }
  for (const a of accounts) {
    const actions = await planLink(config, a, config.sharedItems);
    const t = tally(actions);
    const label = a.isDefault ? `${a.name} ${chalk.dim("(default)")}` : a.name;
    const parts = [`${t.linked} linked`, `${t.unlinked} shareable`];
    if (t.diverged) parts.push(chalk.cyan(`${t.diverged} diverged`));
    if (t.broken) parts.push(chalk.red(`${t.broken} broken`));
    out(`  ${label.padEnd(28)} ${parts.join(", ")}`);
  }
}

function tally(actions: PlannedAction[]) {
  let linked = 0;
  let unlinked = 0;
  let broken = 0;
  let diverged = 0;
  for (const a of actions) {
    if (a.entryState === "LINKED") linked++;
    else if (a.entryState === "REAL_DIR" || a.entryState === "REAL_FILE") unlinked++;
    else if (a.entryState === "BROKEN" || a.entryState === "WRONG_TARGET") broken++;
    if (a.diverged) diverged++;
  }
  return { linked, unlinked, broken, diverged };
}

import { homedir } from "node:os";
import { join } from "node:path";
import {
  type GlobalOpts,
  confirm,
  fail,
  loadFromGlobals,
  out,
  printPlan,
  success,
} from "./_util.js";
import { BACKUP_DIRNAME } from "../config/defaults.js";
import { discoverAccounts, requireAccount } from "../core/accounts.js";
import { assertStoreSafe } from "../core/store.js";
import { planLink } from "../core/plan.js";
import { applyLink } from "../core/link.js";
import { stamp } from "./_stamp.js";

export async function repairCommand(
  g: GlobalOpts,
  accountArg: string | undefined,
  opts: { all?: boolean }
): Promise<void> {
  const config = await loadFromGlobals(g);
  const allAccounts = await discoverAccounts(config);
  try {
    assertStoreSafe(config.storePath, homedir(), allAccounts);
  } catch (err) {
    fail((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const targets = opts.all ? allAccounts : [requireAccount(allAccounts, accountArg)];

  const actions = [];
  for (const acc of targets) {
    const planned = await planLink(config, acc, config.sharedItems);
    actions.push(...planned.filter((a) => a.action === "repair"));
  }

  if (!actions.length) {
    out("Nothing to repair.");
    return;
  }
  printPlan(actions, g.json);
  if (g.dryRun) return;
  if (!g.yes && !(await confirm("\nProceed?"))) {
    out("Aborted.");
    return;
  }

  const batch = stamp();
  for (const acc of targets) {
    const acctActions = actions.filter((a) => a.account === acc.name);
    if (!acctActions.length) continue;
    const backupDir = join(config.storePath, BACKUP_DIRNAME, acc.name, batch);
    await applyLink(acctActions, {
      storeRoot: config.storePath,
      backup: true,
      backupDir,
    });
  }
  success("\nDone.");
}

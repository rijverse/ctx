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
  warn,
} from "./_util.js";
import { BACKUP_DIRNAME } from "../config/defaults.js";
import { selectItems } from "../config/manifest.js";
import { discoverAccounts, requireAccount } from "../core/accounts.js";
import { assertStoreSafe, ensureStore } from "../core/store.js";
import { planLink, isMutating } from "../core/plan.js";
import { applyLink } from "../core/link.js";
import { stamp } from "./_stamp.js";

export interface LinkOpts {
  all?: boolean;
  only?: string[];
  force?: boolean;
  backup?: boolean; // --no-backup sets this false
}

export async function linkCommand(
  g: GlobalOpts,
  accountArg: string | undefined,
  opts: LinkOpts
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
  const items = selectItems(config, opts.only);

  const actions = [];
  for (const acc of targets) actions.push(...(await planLink(config, acc, items)));

  // Diverged files overwrite the account copy with the store's; require an
  // explicit go-ahead. Without it, skip just those and link the rest.
  const allow = opts.force || g.yes;
  let divergedSkipped = 0;
  if (!allow) {
    for (const a of actions) {
      if (a.action === "relink" && a.diverged) {
        a.action = "skip";
        a.detail = "diverged; re-run with --force to overwrite (store wins)";
        divergedSkipped++;
      }
    }
  }

  printPlan(actions, g.json);
  if (g.dryRun) return;

  const mutating = actions.filter(isMutating);
  if (!mutating.length) {
    if (divergedSkipped) warn(`${divergedSkipped} diverged item(s) skipped; use --force to overwrite.`);
    out("\nNothing to do.");
    return;
  }
  if (!g.yes && !(await confirm("\nProceed?"))) {
    out("Aborted.");
    return;
  }

  await ensureStore(config);
  const batch = stamp();
  const backup = opts.backup !== false;
  for (const acc of targets) {
    const acctActions = actions.filter((a) => a.account === acc.name);
    const backupDir = join(config.storePath, BACKUP_DIRNAME, acc.name, batch);
    await applyLink(acctActions, {
      storeRoot: config.storePath,
      backup,
      backupDir,
    });
  }
  if (divergedSkipped) warn(`${divergedSkipped} diverged item(s) skipped; use --force to overwrite.`);
  success("\nDone.");
}

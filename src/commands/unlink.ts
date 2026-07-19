import {
  type GlobalOpts,
  confirm,
  loadFromGlobals,
  out,
  printPlan,
  success,
} from "./_util.js";
import { selectItems } from "../config/manifest.js";
import { discoverAccounts, requireAccount } from "../core/accounts.js";
import { planUnlink, isMutating } from "../core/plan.js";
import { applyUnlink } from "../core/unlink.js";

export interface UnlinkOpts {
  all?: boolean;
  only?: string[];
}

export async function unlinkCommand(
  g: GlobalOpts,
  accountArg: string | undefined,
  opts: UnlinkOpts
): Promise<void> {
  const config = await loadFromGlobals(g);
  const allAccounts = await discoverAccounts(config);
  const targets = opts.all ? allAccounts : [requireAccount(allAccounts, accountArg)];
  const items = selectItems(config, opts.only);

  const actions = [];
  for (const acc of targets) actions.push(...(await planUnlink(config, acc, items)));

  printPlan(actions, g.json);
  if (g.dryRun) return;

  const mutating = actions.filter(isMutating);
  if (!mutating.length) {
    out("\nNothing to do.");
    return;
  }
  if (!g.yes && !(await confirm("\nProceed?"))) {
    out("Aborted.");
    return;
  }

  await applyUnlink(actions);
  success("\nDone.");
}

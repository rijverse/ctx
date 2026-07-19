import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { loadConfig, type ResolvedConfig } from "../config/manifest.js";
import type { ActionKind, PlannedAction } from "../types.js";

export interface GlobalOpts {
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  verbose?: boolean;
  config?: string;
  store?: string;
}

export async function loadFromGlobals(g: GlobalOpts): Promise<ResolvedConfig> {
  return loadConfig({ configPath: g.config, storePath: g.store });
}

export function out(msg = ""): void {
  console.log(msg);
}
export function info(msg: string): void {
  console.log(msg);
}
export function warn(msg: string): void {
  console.error(chalk.yellow(`warning: ${msg}`));
}
export function fail(msg: string): void {
  console.error(chalk.red(`error: ${msg}`));
}
export function success(msg: string): void {
  console.log(chalk.green(msg));
}

/** Ask a yes/no question. Non-interactive stdin answers "no" (be safe). */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

/** Interactive multi-select checklist; returns the set of checked names. */
export async function chooseSharedItems(
  entries: { name: string; present: boolean; checked: boolean }[]
): Promise<Set<string>> {
  const state = entries.map((e) => ({ ...e }));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      out();
      state.forEach((e, i) => {
        const box = e.checked ? chalk.green("[x]") : "[ ]";
        const tag = e.present ? chalk.dim("(present)") : chalk.dim("(absent)");
        out(`  ${String(i + 1).padStart(2)}. ${box} ${e.name}  ${tag}`);
      });
      const ans = (
        await rl.question(
          "\nToggle numbers (space/comma separated), or Enter to accept: "
        )
      ).trim();
      if (!ans) break;
      for (const tok of ans.split(/[\s,]+/)) {
        const idx = parseInt(tok, 10) - 1;
        const target = state[idx];
        if (target) target.checked = !target.checked;
      }
    }
  } finally {
    rl.close();
  }
  return new Set(state.filter((e) => e.checked).map((e) => e.name));
}

const ACTION_COLOR: Record<ActionKind, (s: string) => string> = {
  noop: chalk.dim,
  skip: chalk.dim,
  seed: chalk.green,
  merge: chalk.green,
  adopt: chalk.green,
  relink: chalk.cyan,
  repair: chalk.yellow,
  unlink: chalk.cyan,
};

/** Print planned actions grouped by account (or JSON). */
export function printPlan(actions: PlannedAction[], json = false): void {
  if (json) {
    out(JSON.stringify(actions, null, 2));
    return;
  }
  if (actions.length === 0) {
    out(chalk.dim("  (no shared items)"));
    return;
  }
  let current = "";
  for (const a of actions) {
    if (a.account !== current) {
      current = a.account;
      out(chalk.bold(`\n${current}`));
    }
    const color = ACTION_COLOR[a.action];
    const verb = color(a.action.padEnd(7));
    const name = a.item.name.padEnd(16);
    out(`  ${verb} ${name} ${chalk.dim(a.detail ?? "")}`);
  }
}

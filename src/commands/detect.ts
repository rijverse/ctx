import { resolve } from "node:path";
import chalk from "chalk";
import { detectAdapters } from "../adapters/registry.js";

export async function detectCommand(cwdArg?: string): Promise<void> {
  const cwd = resolve(cwdArg ?? process.cwd());
  const results = await detectAdapters(cwd);

  if (results.length === 0) {
    console.log(chalk.yellow(`No known CLI sessions found for ${cwd}`));
    console.log(chalk.dim("Tip: run a session in Claude Code, puku-cli, or another supported tool first."));
    return;
  }

  console.log(chalk.bold(`Detection results for ${cwd}\n`));
  for (const r of results) {
    const pct = Math.round(r.confidence * 100);
    const color = pct >= 80 ? chalk.green : pct >= 40 ? chalk.yellow : chalk.red;
    console.log(`  ${color(`${String(pct).padStart(3)}%`)}  ${chalk.bold(r.adapter.tool)}`);
    for (const cue of r.cues) {
      console.log(chalk.dim(`        ${cue}`));
    }
  }

  const top = results[0];
  if (top && results.length === 1) {
    console.log(chalk.dim(`\nUse ${top.adapter.tool} as the default tool for this project.`));
  } else if (top) {
    console.log(chalk.dim(`\nUse --tool <name> to disambiguate, e.g. --tool ${top.adapter.tool}.`));
  }
}
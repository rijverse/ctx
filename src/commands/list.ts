import chalk from "chalk";
import { resolveCwd, resolveTool, adapterFor } from "./_util.js";
import type { ToolName } from "../schema/portable.js";

interface ListOptions {
  tool?: ToolName;
  recent?: number;
  cwdArg?: string;
  json?: boolean;
}

export async function listCommand(opts: ListOptions): Promise<void> {
  const cwd = resolveCwd(opts.cwdArg);
  const tool = await resolveTool(opts.tool, cwd);
  if (!tool) {
    console.error(chalk.yellow(`No sessions found for ${cwd}`));
    process.exitCode = 1;
    return;
  }

  const adapter = adapterFor(tool);
  const sessions: Array<{
    id: string;
    sizeBytes: number;
    mtime: string;
    cwd: string;
  }> = [];

  for await (const ref of adapter.listSessions(cwd)) {
    sessions.push(ref);
  }

  sessions.sort((a, b) => b.mtime.localeCompare(a.mtime));

  const recent = opts.recent ? sessions.slice(0, opts.recent) : sessions;

  if (opts.json) {
    console.log(JSON.stringify(recent, null, 2));
    return;
  }

  if (recent.length === 0) {
    console.log(chalk.yellow(`No sessions for ${tool} in ${cwd}`));
    return;
  }

  console.log(chalk.bold(`${recent.length} session(s) from ${tool}\n`));
  console.log(
    `  ${chalk.dim("ID".padEnd(40))} ${chalk.dim("SIZE".padStart(10))} ${chalk.dim("MODIFIED".padStart(24))}`
  );
  for (const s of recent) {
    const id = s.id.padEnd(40);
    const size = humanSize(s.sizeBytes).padStart(10);
    const mtime = s.mtime.replace("T", " ").replace(/\.\d+Z$/, "Z").padStart(24);
    console.log(`  ${id} ${size} ${mtime}`);
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
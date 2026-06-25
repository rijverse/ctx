import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import chalk from "chalk";
import { resolveCwd, resolveTool, adapterFor, findSession } from "./_util.js";
import { UnsupportedOperationError } from "../adapters/types.js";
import type { ToolName } from "../schema/portable.js";

interface ExportOptions {
  tool?: ToolName;
  output?: string;
  cwdArg?: string;
  redact?: boolean;
}

export async function exportCommand(
  sessionId: string,
  opts: ExportOptions
): Promise<void> {
  const cwd = resolveCwd(opts.cwdArg);
  const tool = await resolveTool(opts.tool, cwd);
  if (!tool) {
    console.error(chalk.yellow(`No sessions found for ${cwd}`));
    process.exitCode = 1;
    return;
  }

  const adapter = adapterFor(tool);
  const ref = await findSession(adapter, cwd, sessionId);
  if (!ref) {
    console.error(chalk.red(`Session ${sessionId} not found in ${tool}`));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.dim(`Reading session ${ref.id} from ${tool}...`));

  let portable;
  try {
    portable = await adapter.buildPortableSession(ref, { redact: opts.redact });
  } catch (err) {
    if (err instanceof UnsupportedOperationError) {
      console.error(chalk.red(err.message));
    } else {
      throw err;
    }
    process.exitCode = 1;
    return;
  }

  const output = opts.output ?? `./ctx-handoff-${ref.id.slice(0, 8)}.json`;
  await writeFile(resolve(output), JSON.stringify(portable, null, 2), "utf8");

  console.log(chalk.green(`✓ Exported ${portable.messages.length} messages to ${output}`));
  if (opts.redact) {
    console.log(chalk.dim(`  (tool_result bodies redacted)`));
  }
}
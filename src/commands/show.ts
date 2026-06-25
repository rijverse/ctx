import chalk from "chalk";
import { resolveCwd, resolveTool, adapterFor, findSession } from "./_util.js";
import type { ContentBlock, PortableMessage, ToolName } from "../schema/portable.js";

interface ShowOptions {
  tool?: ToolName;
  cwdArg?: string;
}

export async function showCommand(sessionId: string, opts: ShowOptions): Promise<void> {
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

  console.log(chalk.bold(`Session ${ref.id}`));
  console.log(`  ${chalk.dim("Tool:")}     ${tool}`);
  console.log(`  ${chalk.dim("CWD:")}      ${ref.cwd}`);
  console.log(`  ${chalk.dim("Size:")}     ${ref.sizeBytes} bytes`);
  console.log(`  ${chalk.dim("Modified:")} ${ref.mtime}`);
  console.log();

  console.log(chalk.bold("First messages:\n"));
  let count = 0;
  for await (const msg of adapter.exportSession(ref)) {
    if (count >= 5) {
      console.log(chalk.dim("  ... (truncated; run `ctx export` for the full session)"));
      break;
    }
    count++;
    const roleColor =
      msg.role === "user" ? chalk.cyan : msg.role === "assistant" ? chalk.green : chalk.yellow;
    console.log(`  ${roleColor(msg.role.toUpperCase())}:`);
    console.log(`    ${summarizeMessage(msg)}`);
    console.log();
  }
}

function summarizeMessage(msg: PortableMessage): string {
  if (typeof msg.content === "string") return truncate(msg.content);
  return `[${msg.content.map(blockLabel).join(", ")}] ${truncate(blocksToText(msg.content))}`;
}

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join(" ");
}

function blockLabel(b: ContentBlock): string {
  return b.type;
}

function truncate(s: string): string {
  const firstLine = s.split("\n")[0] ?? "";
  return firstLine.length > 120 ? firstLine.slice(0, 120) + "..." : firstLine || "(empty)";
}
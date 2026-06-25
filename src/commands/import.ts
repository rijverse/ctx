import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import chalk from "chalk";
import {
  PortableSessionSchema,
  NATIVE_CAPABLE,
  type PortableSession,
  type ToolName,
} from "../schema/portable.js";
import { renderMarkdownHandoff } from "../render/markdown-handoff.js";
import { writeNativeClaudeSession } from "../render/native-claude.js";

interface ImportOptions {
  targetTool: ToolName;
  targetCwd?: string;
  writeNative?: boolean;
  dryRun?: boolean;
  decisions?: string[];
}

export async function importCommand(
  inputPath: string,
  opts: ImportOptions
): Promise<void> {
  const absInput = resolve(inputPath);
  const raw = await readFile(absInput, "utf8");

  let session: PortableSession;
  try {
    session = PortableSessionSchema.parse(JSON.parse(raw)) as PortableSession;
  } catch (err) {
    console.error(chalk.red(`Invalid portable session file: ${(err as Error).message}`));
    process.exitCode = 1;
    return;
  }

  if (opts.decisions && opts.decisions.length > 0) {
    session = { ...session, decisions: opts.decisions };
  }

  const targetCwd = resolve(opts.targetCwd ?? session.session.cwd ?? process.cwd());

  console.log(chalk.bold(`Importing session ${session.session.id}`));
  console.log(`  ${chalk.dim("Source:")}    ${session.source.tool} ${session.source.version ?? ""}`);
  console.log(`  ${chalk.dim("Target:")}    ${opts.targetTool}`);
  console.log(`  ${chalk.dim("Target cwd:")} ${targetCwd}`);
  console.log(`  ${chalk.dim("Messages:")}  ${session.messages.length}`);
  console.log(`  ${chalk.dim("Decisions:")} ${session.decisions?.length ?? 0}`);
  console.log();

  // 1) Always produce a markdown handoff in the target cwd
  const handoffPath = join(targetCwd, ".ctx-handoff.md");
  const md = renderMarkdownHandoff(session);
  if (opts.dryRun) {
    console.log(chalk.dim(`Would write: ${handoffPath}`));
  } else {
    await mkdir(targetCwd, { recursive: true });
    await writeFile(handoffPath, md, "utf8");
    console.log(chalk.green(`✓ Wrote markdown handoff → ${handoffPath}`));
    console.log(chalk.dim(`  Paste the contents into ${opts.targetTool} to bring it up to speed.`));
  }

  // 2) Optional: write a synthetic native JSONL
  if (opts.writeNative) {
    if (!NATIVE_CAPABLE.has(opts.targetTool)) {
      console.error(
        chalk.red(
          `--write-native is only supported for "claude" and "puku" (got "${opts.targetTool}"). Markdown handoff written.`
        )
      );
      process.exitCode = 1;
      return;
    }

    try {
      const { filePath } = await writeNativeClaudeSession(
        session,
        opts.targetTool,
        targetCwd,
        { dryRun: opts.dryRun ?? false }
      );
      if (opts.dryRun) {
        console.log(chalk.dim(`Would write native JSONL: ${filePath}`));
      } else {
        console.log(chalk.green(`✓ Wrote native JSONL → ${filePath}`));
      }
    } catch (err) {
      console.error(chalk.red(`Failed to write native session: ${(err as Error).message}`));
      process.exitCode = 1;
      return;
    }
  } else if (NATIVE_CAPABLE.has(opts.targetTool)) {
    console.log();
    console.log(chalk.dim(`Tip: re-run with --write-native to also create a synthetic JSONL`));
    console.log(chalk.dim(`     that ${opts.targetTool} will pick up as a real session.`));
  }
}
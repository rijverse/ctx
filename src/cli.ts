#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectCommand } from "./commands/detect.js";
import { listCommand } from "./commands/list.js";
import { showCommand } from "./commands/show.js";
import { exportCommand } from "./commands/export.js";
import { importCommand } from "./commands/import.js";
import { schemaCommand } from "./commands/schema.js";
import { ToolNameSchema, type ToolName } from "./schema/portable.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let version = "0.0.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8")
  ) as { version?: string };
  if (pkg.version) version = pkg.version;
} catch (err) {
  console.warn(`ctx: could not read version from package.json: ${(err as Error).message}`);
}

const TOOLS: ToolName[] = ToolNameSchema.options;

/** A reusable --tool option that validates against the ToolName enum. */
const toolOption = (description: string) =>
  new Option(`-t, --tool <tool>`, description).choices(TOOLS);

const program = new Command();
program
  .name("ctx")
  .description("Export and import AI coding session context between CLIs")
  .version(version);

program
  .command("detect")
  .description("Detect which CLIs have sessions for a project")
  .argument("[path]", "project directory (defaults to cwd)")
  .action((path?: string) => detectCommand(path));

program
  .command("list")
  .description("List sessions for the current project")
  .argument("[path]", "project directory (defaults to cwd)")
  .addOption(toolOption("source tool"))
  .option("-n, --recent <n>", "show only the N most recent", (v: string) => parseInt(v, 10))
  .option("--json", "emit JSON")
  .action((path: string | undefined, opts: { tool?: ToolName; recent?: number; json?: boolean }) => {
    return listCommand({
      tool: opts.tool,
      recent: opts.recent,
      cwdArg: path,
      json: opts.json,
    });
  });

program
  .command("show")
  .description("Show a summary of a specific session")
  .argument("<session-id>", "session id (or prefix)")
  .argument("[path]", "project directory (defaults to cwd)")
  .addOption(toolOption("source tool"))
  .action((id: string, path: string | undefined, opts: { tool?: ToolName }) => {
    return showCommand(id, { tool: opts.tool, cwdArg: path });
  });

program
  .command("export")
  .description("Export a session to a portable JSON file")
  .argument("<session-id>", "session id (or prefix)")
  .argument("[path]", "project directory (defaults to cwd)")
  .addOption(toolOption("source tool"))
  .option("-o, --output <file>", "output file (default: ./ctx-handoff-<id8>.json)")
  .option("--redact", "strip tool_result bodies (for shareable exports)")
  .action(
    (
      id: string,
      path: string | undefined,
      opts: { tool?: ToolName; output?: string; redact?: boolean }
    ) => {
      return exportCommand(id, {
        tool: opts.tool,
        output: opts.output,
        cwdArg: path,
        redact: opts.redact,
      });
    }
  );

program
  .command("import")
  .description("Import a portable JSON into a target CLI's workflow")
  .argument("<file>", "portable JSON file (from `ctx export`)")
  .addOption(new Option("--to <tool>", "target tool").choices(TOOLS).makeOptionMandatory(true))
  .option("--target-cwd <path>", "target working directory (defaults to session.cwd)")
  .option("--write-native", "also write a synthetic native JSONL (claude/puku only)")
  .option("--dry-run", "show what would happen without writing files")
  .option("--decision <text>", "add a decision to carry forward (repeatable)", collectDecisions, [])
  .action(
    (
      file: string,
      opts: {
        to: ToolName;
        targetCwd?: string;
        writeNative?: boolean;
        dryRun?: boolean;
        decision: string[];
      }
    ) => {
      return importCommand(file, {
        targetTool: opts.to,
        targetCwd: opts.targetCwd,
        writeNative: opts.writeNative,
        dryRun: opts.dryRun,
        decisions: opts.decision,
      });
    }
  );

program
  .command("schema")
  .description("Print the portable JSON Schema")
  .action(() => {
    schemaCommand();
  });

function collectDecisions(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

program.parseAsync(process.argv).catch((err: Error) => {
  // Commander throws for usage errors (unknown options, missing required
  // args, invalid choices) with a structured exit code, which we honor.
  // For everything else, print the error and exit 1.
  if (err instanceof CommanderError) {
    process.exit(err.exitCode);
  }
  console.error(err);
  process.exit(1);
});
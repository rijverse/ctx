import { spawn } from "node:child_process";
import { type GlobalOpts, fail, loadFromGlobals } from "./_util.js";
import { resolveAccount } from "../core/accounts.js";

/**
 * Launch `claude` for an account by setting CLAUDE_CONFIG_DIR. The default
 * account leaves the variable unset so Claude uses ~/.claude and ~/.claude.json
 * as it normally would.
 */
export async function runCommand(
  g: GlobalOpts,
  accountArg: string,
  claudeArgs: string[]
): Promise<void> {
  const config = await loadFromGlobals(g);
  const account = await resolveAccount(config, accountArg);

  const env = { ...process.env };
  if (account.isDefault) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = account.dir;

  const args = claudeArgs.filter((a) => a !== "--");
  await new Promise<void>((resolve) => {
    const child = spawn("claude", args, { env, stdio: "inherit" });
    child.on("exit", (code, signal) => {
      process.exitCode = signal ? 1 : code ?? 0;
      resolve();
    });
    child.on("error", (e) => {
      fail(`failed to launch claude: ${(e as Error).message}`);
      process.exitCode = 127;
      resolve();
    });
  });
}

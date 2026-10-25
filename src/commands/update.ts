import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tilde } from "../core/paths.js";
import type { Parsed } from "../util/args.js";
import { exists, readJson } from "../util/fsx.js";
import { CtxError, cyan, dim, fail, out, yellow } from "../util/ui.js";

const INSTALL_URL = "https://raw.githubusercontent.com/rijverse/ctx/main/install.sh";
const TIMEOUT_MS = 15_000;

/** What install.sh leaves in install.json next to the build, so an update knows where it came from. */
export interface Install {
  repo: string;
  ref: string;
  /** null when GitHub could not name one at install time. */
  commit: string | null;
  bin: string;
}

/** The package root this ctx runs from, through any npm link. */
export async function ownRoot(): Promise<string> {
  return realpath(fileURLToPath(new URL("../../", import.meta.url)));
}

export async function readInstall(root: string): Promise<Install | undefined> {
  try {
    return await readJson<Install>(join(root, "install.json"));
  } catch {
    return undefined;
  }
}

export async function update(args: Parsed): Promise<number> {
  return selfUpdate(await ownRoot(), {
    check: args.flags.has("dry-run") || args.flags.has("n"),
    force: args.flags.has("force"),
  });
}

/**
 * Update an install that install.sh made by running the install.sh of the
 * newest commit on the same ref over it. Any other kind of install is
 * someone else's to update, so it only says how.
 */
export async function selfUpdate(root: string, opts: { check: boolean; force: boolean }): Promise<number> {
  const install = await readInstall(root);
  if (install === undefined) {
    if (await exists(join(root, ".git"))) {
      out(`ctx runs from a git checkout at ${cyan(tilde(root))}. Update it there with \`git pull && npm run build\`.`);
    } else if (root.split(sep).includes("node_modules")) {
      out("ctx was installed with npm. Update it with `npm install -g @rijverse/ctx`.");
    } else {
      out(`ctx at ${tilde(root)} was not installed by install.sh, so it cannot update itself. Install it again with:`);
      out(`  curl -fsSL ${INSTALL_URL} | bash`);
    }
    return 1;
  }

  const have = install.commit === null ? "an unknown commit" : short(install.commit);
  let latest: string | undefined;
  if (opts.check || !opts.force) {
    latest = await latestCommit(install);
    if (latest === install.commit) {
      out(`ctx is up to date ${dim(`(${have} on ${install.ref})`)}`);
      return 0;
    }
  }
  if (opts.check) {
    out(`${short(latest!)} is out on ${install.ref}, this is ${have}. \`ctx update\` installs it.`);
    return 0;
  }

  out(`Updating ctx ${have} -> ${latest === undefined ? install.ref : short(latest)}`);
  // The install.sh of the commit being installed, which may know more than the one that made this install.
  const script = await download(`https://raw.githubusercontent.com/${install.repo}/${latest ?? install.ref}/install.sh`);
  return runInstaller(script, { CTX_REF: install.ref, CTX_INSTALL_DIR: root, CTX_BIN_DIR: install.bin });
}

async function latestCommit(install: Install): Promise<string> {
  let text: string;
  try {
    text = await download(`https://api.github.com/repos/${install.repo}/commits/${install.ref}`, "application/vnd.github.sha");
  } catch (e) {
    if (!(e instanceof CtxError)) throw e;
    fail(`${e.message}. \`ctx update --force\` installs without checking first.`);
  }
  const sha = text.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) fail(`GitHub did not name a commit for ${install.ref}`);
  return sha;
}

async function download(url: string, accept?: string): Promise<string> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await fetch(url, { headers: accept === undefined ? {} : { accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") fail(`${host} did not answer in ${TIMEOUT_MS / 1000}s`);
    const code = ((e as Error).cause as NodeJS.ErrnoException | undefined)?.code;
    fail(`could not reach ${host}${code === undefined ? "" : ` (${code})`}`);
  }
  if (!res.ok) fail(`${host} answered ${res.status}`);
  return res.text();
}

function runInstaller(script: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    // Run from home, because the install being replaced may be the current directory.
    const child = spawn("bash", ["-s"], {
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, ...env },
      cwd: homedir(),
    });
    child.on("error", (e) => {
      out(yellow(`could not run bash: ${e.message}`));
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.stdin.end(script);
  });
}

function short(commit: string): string {
  return commit.slice(0, 7);
}

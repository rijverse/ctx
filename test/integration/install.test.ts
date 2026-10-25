import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exists } from "../../src/util/fsx.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../install.sh", import.meta.url));
const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

let t: string;
let dir: string;
beforeEach(async () => {
  t = await mkdtemp(join(tmpdir(), "ctx-installsh-"));
  dir = join(t, "share", "ctx");
});
afterEach(async () => {
  await rm(t, { recursive: true, force: true });
});

/** An install a previous run made, at `commit`. */
async function installed(commit: string | null, starts = true): Promise<void> {
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@rijverse/ctx" }, null, 2));
  if (starts) await writeFile(join(dir, "dist", "cli.js"), "#!/bin/sh\necho 1.0.0\n", { mode: 0o755 });
  await writeFile(join(dir, "install.json"), JSON.stringify({ repo: "rijverse/ctx", ref: "main", commit, bin: join(t, "bin") }));
}

/**
 * Runs install.sh with a curl that names `head` as the tip of the ref, or
 * fails like GitHub would when `head` is empty, and fails every download
 * after noting it. So nothing is ever fetched for real.
 */
async function install(head: string, env: Record<string, string> = {}) {
  const fake = join(t, "fakebin");
  const log = join(t, "downloads");
  await mkdir(fake, { recursive: true });
  await writeFile(
    join(fake, "curl"),
    [
      "#!/bin/sh",
      'for a in "$@"; do url=$a; done',
      'case $url in',
      `  https://api.github.com/*) [ -n "${head}" ] || exit 22; printf '%s' "${head}"; exit 0 ;;`,
      "esac",
      `echo "$url" >> "${log}"`,
      "exit 22",
    ].join("\n"),
    { mode: 0o755 },
  );
  let out: string;
  let code = 0;
  try {
    const r = await run("bash", [SCRIPT], {
      env: {
        ...process.env,
        PATH: `${fake}:${process.env.PATH}`,
        CTX_INSTALL_DIR: dir,
        CTX_BIN_DIR: join(t, "bin"),
        CTX_FORCE: "",
        CTX_CHECK: "",
        ...env,
      },
    });
    out = r.stdout + r.stderr;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    out = (err.stdout ?? "") + (err.stderr ?? "");
    code = err.code ?? 1;
  }
  const downloads = (await exists(log)) ? (await readFile(log, "utf8")).trim().split("\n") : [];
  return { out, code, downloads };
}

describe("install.sh", () => {
  it("says it is up to date and downloads nothing when that commit is installed", async () => {
    await installed(OLD);
    const r = await install(OLD);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ctx is up to date (aaaaaaa on main)");
    expect(r.downloads).toEqual([]);
  });

  it("only says what is newer under CTX_CHECK", async () => {
    await installed(OLD);
    const r = await install(NEW, { CTX_CHECK: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("bbbbbbb is out on main, this is aaaaaaa");
    expect(r.downloads).toEqual([]);
  });

  it("downloads the newer commit, and keeps the old install when that fails", async () => {
    await installed(OLD);
    const r = await install(NEW);
    expect(r.out).toContain("Updating ctx aaaaaaa -> bbbbbbb");
    expect(r.downloads).toEqual([`https://github.com/rijverse/ctx/archive/${NEW}.tar.gz`]);
    expect(r.code).toBe(1);
    expect(await exists(join(dir, "dist", "cli.js"))).toBe(true);
  });

  it("reinstalls under CTX_FORCE, and over an install that no longer starts", async () => {
    await installed(OLD);
    expect((await install(OLD, { CTX_FORCE: "1" })).downloads).toHaveLength(1);

    await rm(join(t, "downloads"));
    await installed(OLD, false);
    await rm(join(dir, "dist", "cli.js"));
    expect((await install(OLD)).downloads).toHaveLength(1);
  });

  it("downloads the ref itself when GitHub will not name a commit, but will not guess under CTX_CHECK", async () => {
    await installed(OLD);
    expect((await install("")).downloads).toEqual(["https://github.com/rijverse/ctx/archive/main.tar.gz"]);

    const check = await install("", { CTX_CHECK: "1" });
    expect(check.code).toBe(1);
    expect(check.out).toContain("GitHub did not say");
  });
});

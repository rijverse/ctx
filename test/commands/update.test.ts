import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selfUpdate } from "../../src/commands/update.js";

const OLD = "a".repeat(40);

let root: string;
let said: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ctx-install-"));
  said = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    said += String(s);
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

async function installed(commit: string | null): Promise<void> {
  const record = { repo: "rijverse/ctx", ref: "main", commit, bin: join(root, "bin") };
  await writeFile(join(root, "install.json"), JSON.stringify(record));
}

/** GitHub serves an install.sh that notes how it was run. */
function github(script?: string) {
  const seen = join(root, "seen");
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/install.sh")) {
      return new Response(
        script ??
          `printf 'ref=%s dir=%s bin=%s force=%s check=%s' "$CTX_REF" "$CTX_INSTALL_DIR" "$CTX_BIN_DIR" "$CTX_FORCE" "$CTX_CHECK" > '${seen}'\n`,
      );
    }
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, seen, urls: () => fetch.mock.calls.map((c) => c[0]) };
}

describe("ctx update", () => {
  it("runs the ref's install.sh over this install, keeping its ref and bin dir", async () => {
    await installed(OLD);
    const gh = github();
    expect(await selfUpdate(root, { check: false, force: false })).toBe(0);
    expect(gh.urls()).toEqual(["https://raw.githubusercontent.com/rijverse/ctx/main/install.sh"]);
    expect(await readFile(gh.seen, "utf8")).toBe(`ref=main dir=${root} bin=${join(root, "bin")} force= check=`);
  });

  it("hands --dry-run and --force to install.sh, never both", async () => {
    await installed(OLD);
    const gh = github();
    await selfUpdate(root, { check: true, force: false });
    expect(await readFile(gh.seen, "utf8")).toContain("force= check=1");

    await selfUpdate(root, { check: false, force: true });
    expect(await readFile(gh.seen, "utf8")).toContain("force=1 check=");

    await selfUpdate(root, { check: true, force: true });
    expect(await readFile(gh.seen, "utf8")).toContain("force= check=1");
  });

  it("does not let CTX_FORCE or CTX_CHECK from the shell leak in", async () => {
    await installed(null);
    const gh = github();
    vi.stubEnv("CTX_FORCE", "1");
    vi.stubEnv("CTX_CHECK", "1");
    await selfUpdate(root, { check: false, force: false });
    vi.unstubAllEnvs();
    expect(await readFile(gh.seen, "utf8")).toContain("force= check=");
  });

  it("passes a failed install through", async () => {
    await installed(OLD);
    github("exit 3\n");
    expect(await selfUpdate(root, { check: false, force: false })).toBe(3);
  });

  it("says so when install.sh cannot be fetched", async () => {
    await installed(OLD);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(selfUpdate(root, { check: false, force: false })).rejects.toThrow("503");
  });

  it("leaves a git checkout to git", async () => {
    await mkdir(join(root, ".git"));
    const gh = github();
    expect(await selfUpdate(root, { check: false, force: false })).toBe(1);
    expect(said).toContain("git pull");
    expect(gh.fetch).not.toHaveBeenCalled();
  });

  it("points an install it did not make at install.sh", async () => {
    const gh = github();
    expect(await selfUpdate(root, { check: false, force: false })).toBe(1);
    expect(said).toContain("install.sh | bash");
    expect(gh.fetch).not.toHaveBeenCalled();
  });
});

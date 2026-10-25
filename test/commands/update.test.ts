import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selfUpdate } from "../../src/commands/update.js";
import { exists } from "../../src/util/fsx.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

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

/** GitHub names `head` as the tip of main and serves an install.sh that notes how it was run. */
function github(head: string, script?: string) {
  const seen = join(root, "seen");
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith("https://api.github.com/")) return new Response(head);
    if (url.endsWith("/install.sh")) {
      return new Response(script ?? `printf '%s %s %s' "$CTX_REF" "$CTX_INSTALL_DIR" "$CTX_BIN_DIR" > '${seen}'\n`);
    }
    return new Response("", { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, seen, urls: () => fetch.mock.calls.map((c) => c[0]) };
}

describe("ctx update", () => {
  it("installs nothing when main has not moved", async () => {
    await installed(NEW);
    const gh = github(NEW);
    expect(await selfUpdate(root, { check: false, force: false })).toBe(0);
    expect(said).toContain("up to date");
    expect(gh.urls()).toEqual(["https://api.github.com/repos/rijverse/ctx/commits/main"]);
    expect(await exists(gh.seen)).toBe(false);
  });

  it("runs the newer commit's install.sh over this install, keeping its ref and bin dir", async () => {
    await installed(OLD);
    const gh = github(NEW);
    expect(await selfUpdate(root, { check: false, force: false })).toBe(0);
    expect(gh.urls()).toContain(`https://raw.githubusercontent.com/rijverse/ctx/${NEW}/install.sh`);
    expect(await readFile(gh.seen, "utf8")).toBe(`main ${root} ${join(root, "bin")}`);
    expect(said).toContain("aaaaaaa -> bbbbbbb");
  });

  it("updates an install whose commit was never known", async () => {
    await installed(null);
    const gh = github(NEW);
    expect(await selfUpdate(root, { check: false, force: false })).toBe(0);
    expect(await exists(gh.seen)).toBe(true);
  });

  it("only says what is available on --dry-run", async () => {
    await installed(OLD);
    const gh = github(NEW);
    expect(await selfUpdate(root, { check: true, force: false })).toBe(0);
    expect(said).toContain("bbbbbbb");
    expect(gh.urls()).toHaveLength(1);
    expect(await exists(gh.seen)).toBe(false);
  });

  it("reinstalls on --force without asking GitHub first", async () => {
    await installed(NEW);
    const gh = github(NEW);
    expect(await selfUpdate(root, { check: false, force: true })).toBe(0);
    expect(gh.urls()).toEqual(["https://raw.githubusercontent.com/rijverse/ctx/main/install.sh"]);
    expect(await exists(gh.seen)).toBe(true);
  });

  it("passes a failed install through", async () => {
    await installed(OLD);
    github(NEW, "exit 3\n");
    expect(await selfUpdate(root, { check: false, force: false })).toBe(3);
  });

  it("points at --force when GitHub will not name the latest commit", async () => {
    await installed(OLD);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 403 })));
    await expect(selfUpdate(root, { check: false, force: false })).rejects.toThrow("--force");
  });

  it("leaves a git checkout to git", async () => {
    await mkdir(join(root, ".git"));
    const gh = github(NEW);
    expect(await selfUpdate(root, { check: false, force: false })).toBe(1);
    expect(said).toContain("git pull");
    expect(gh.fetch).not.toHaveBeenCalled();
  });

  it("points an install it did not make at install.sh", async () => {
    const gh = github(NEW);
    expect(await selfUpdate(root, { check: false, force: false })).toBe(1);
    expect(said).toContain("install.sh | bash");
    expect(gh.fetch).not.toHaveBeenCalled();
  });
});

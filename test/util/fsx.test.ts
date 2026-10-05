import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeLines, move, readJson, removeEmptyDirs, replaceSymlink, writeJson } from "../../src/util/fsx.js";

const scratch = () => mkdtemp(join(tmpdir(), "ctx-fsx-"));

describe("readJson", () => {
  it("returns undefined only for a missing file", async () => {
    expect(await readJson(join(await scratch(), "nope.json"))).toBeUndefined();
  });

  it("throws on a file that does not parse instead of calling it empty", async () => {
    const p = join(await scratch(), "bad.json");
    await writeFile(p, '{"half":');
    await expect(readJson(p)).rejects.toThrow("not valid JSON");
  });
});

describe("writeJson", () => {
  it("keeps the mode of the file it replaces", async () => {
    const p = join(await scratch(), "f.json");
    await writeFile(p, "{}");
    await chmod(p, 0o600);
    await writeJson(p, { a: 1 });
    expect((await lstat(p)).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlink rather than replacing it", async () => {
    const dir = await scratch();
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    await writeFile(real, "{}");
    await symlink(real, link);
    await writeJson(link, { a: 1 });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8"))).toEqual({ a: 1 });
  });
});

describe("replaceSymlink", () => {
  it("swaps an existing link in place", async () => {
    const dir = await scratch();
    const at = join(dir, "projects");
    await symlink(join(dir, "old"), at);
    await replaceSymlink(at, join(dir, "new"));
    expect(await readlink(at)).toBe(join(dir, "new"));
  });

  it("refuses to replace a real directory", async () => {
    const dir = await scratch();
    const at = join(dir, "projects");
    await mkdir(at);
    await writeFile(join(at, "keep.jsonl"), "x");
    await expect(replaceSymlink(at, join(dir, "store"))).rejects.toThrow("left as it is");
    expect(await readFile(join(at, "keep.jsonl"), "utf8")).toBe("x");
  });
});

describe("removeEmptyDirs", () => {
  it("removes empty directories and never a file", async () => {
    const dir = join(await scratch(), "tree");
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await mkdir(join(dir, "c"), { recursive: true });
    await writeFile(join(dir, "c", "late.jsonl"), "written mid-merge");

    await removeEmptyDirs(dir);

    await expect(lstat(join(dir, "a"))).rejects.toThrow();
    expect(await readFile(join(dir, "c", "late.jsonl"), "utf8")).toBe("written mid-merge");
  });
});

describe("mergeLines", () => {
  const entry = (display: string, timestamp: number) => JSON.stringify({ display, timestamp });

  it("interleaves two histories by time and drops exact duplicates", async () => {
    const dir = await scratch();
    const from = join(dir, "mine.jsonl");
    const to = join(dir, "store.jsonl");
    await writeFile(to, [entry("a", 1), entry("c", 3), entry("shared", 5)].join("\n") + "\n");
    await writeFile(from, [entry("b", 2), entry("shared", 5), entry("d", 4)].join("\n") + "\n");

    await mergeLines(from, to);

    const lines = (await readFile(to, "utf8")).trim().split("\n").map((l) => JSON.parse(l).display);
    expect(lines).toEqual(["a", "b", "c", "d", "shared"]);
  });

  it("keeps a line it cannot read next to the one before it", async () => {
    const dir = await scratch();
    const from = join(dir, "mine.jsonl");
    const to = join(dir, "store.jsonl");
    await writeFile(to, entry("a", 10) + "\n" + entry("c", 30) + "\n");
    await writeFile(from, entry("b", 20) + "\nnot json\n");

    await mergeLines(from, to);

    expect((await readFile(to, "utf8")).trim().split("\n")).toEqual([entry("a", 10), entry("b", 20), "not json", entry("c", 30)]);
  });
});

describe("move", () => {
  it("keeps relative links pointing where they did when the depth changes", async () => {
    const root = await scratch();
    await mkdir(join(root, ".agents", "skills", "shadcn"), { recursive: true });
    await mkdir(join(root, "work", ".claude", "skills", "own"), { recursive: true });
    const skills = join(root, "work", ".claude", "skills");
    await symlink("../../../.agents/skills/shadcn", join(skills, "shadcn"));
    await symlink("own", join(skills, "inside"));

    const store = join(root, ".ctx-store", "skills");
    await move(skills, store);

    expect(await readlink(join(store, "shadcn"))).toBe(join(root, ".agents", "skills", "shadcn"));
    expect((await stat(join(store, "shadcn"))).isDirectory()).toBe(true);
    expect(await readlink(join(store, "inside"))).toBe("own");
  });
});


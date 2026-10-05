import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, removeEmptyDirs, replaceSymlink, writeJson } from "../../src/util/fsx.js";

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

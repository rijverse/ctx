import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { withTmpDir } from "../helpers/tmp.js";
import {
  mkdirp,
  hashFile,
  copyRecursive,
  moveWithExdevFallback,
  atomicSymlink,
  readLinkAbs,
  pathExists,
  removeRecursive,
} from "../../src/fs/ops.js";

describe("hashFile", () => {
  it("is stable and content-sensitive", async () => {
    await withTmpDir(async (dir) => {
      const a = join(dir, "a");
      const b = join(dir, "b");
      await fsp.writeFile(a, "hello");
      await fsp.writeFile(b, "hello");
      expect(await hashFile(a)).toBe(await hashFile(b));
      await fsp.writeFile(b, "world");
      expect(await hashFile(a)).not.toBe(await hashFile(b));
    });
  });
});

describe("copyRecursive", () => {
  it("copies a tree, preserves file mode, and copies inner symlinks verbatim", async () => {
    await withTmpDir(async (dir) => {
      const src = join(dir, "src");
      await mkdirp(join(src, "nested"));
      await fsp.writeFile(join(src, "nested", "f.txt"), "x", { mode: 0o600 });
      await fsp.chmod(join(src, "nested", "f.txt"), 0o600);
      await fsp.symlink("f.txt", join(src, "nested", "link"));

      const dst = join(dir, "dst");
      await copyRecursive(src, dst);

      expect(await fsp.readFile(join(dst, "nested", "f.txt"), "utf8")).toBe("x");
      const st = await fsp.stat(join(dst, "nested", "f.txt"));
      expect(st.mode & 0o777).toBe(0o600);
      const linkStat = await fsp.lstat(join(dst, "nested", "link"));
      expect(linkStat.isSymbolicLink()).toBe(true);
      expect(await fsp.readlink(join(dst, "nested", "link"))).toBe("f.txt");
    });
  });
});

describe("moveWithExdevFallback", () => {
  it("moves a directory (rename path)", async () => {
    await withTmpDir(async (dir) => {
      const src = join(dir, "src");
      await mkdirp(src);
      await fsp.writeFile(join(src, "f"), "data");
      const dst = join(dir, "backup", "src");
      await moveWithExdevFallback(src, dst);
      expect(await pathExists(src)).toBe(false);
      expect(await fsp.readFile(join(dst, "f"), "utf8")).toBe("data");
    });
  });
});

describe("atomicSymlink", () => {
  it("creates a symlink and replaces an existing file", async () => {
    await withTmpDir(async (dir) => {
      const target = join(dir, "target");
      await mkdirp(target);
      const link = join(dir, "link");
      await atomicSymlink(target, link);
      expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readLinkAbs(link)).toBe(target);

      // Replace an existing regular file at the link path.
      const link2 = join(dir, "link2");
      await fsp.writeFile(link2, "old");
      await atomicSymlink(target, link2);
      expect((await fsp.lstat(link2)).isSymbolicLink()).toBe(true);
    });
  });
});

describe("readLinkAbs", () => {
  it("resolves relative and absolute targets", async () => {
    await withTmpDir(async (dir) => {
      await fsp.writeFile(join(dir, "t"), "");
      const rel = join(dir, "rel");
      await fsp.symlink("t", rel);
      expect(await readLinkAbs(rel)).toBe(join(dir, "t"));

      const abs = join(dir, "abs");
      await fsp.symlink(join(dir, "t"), abs);
      expect(await readLinkAbs(abs)).toBe(join(dir, "t"));
    });
  });
});

describe("removeRecursive", () => {
  it("is a no-op on a missing path", async () => {
    await withTmpDir(async (dir) => {
      await removeRecursive(join(dir, "nope"));
      expect(await pathExists(join(dir, "nope"))).toBe(false);
    });
  });
});

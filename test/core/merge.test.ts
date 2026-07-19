import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { withTmpDir } from "../helpers/tmp.js";
import { buildAccount } from "../helpers/fakeHome.js";
import { mergeInto } from "../../src/core/merge.js";

describe("mergeInto", () => {
  it("unions files, keeps store on conflict, recurses, and preserves dir modes", async () => {
    await withTmpDir(async (dir) => {
      const acc = join(dir, "acc", "projects");
      const store = join(dir, "store", "projects");

      await buildAccount(join(dir, "acc"), {
        files: {
          "projects/-p/only-account.jsonl": "A",
          "projects/-p/same.jsonl": "same",
          "projects/-p/conflict.jsonl": "account-version",
          "projects/-p/nested/deep.jsonl": "deep",
        },
        modes: { "projects/-p": 0o700 },
      });
      await buildAccount(join(dir, "store"), {
        files: {
          "projects/-p/same.jsonl": "same",
          "projects/-p/conflict.jsonl": "store-version",
          "projects/-p/only-store.jsonl": "S",
        },
      });

      const res = await mergeInto(acc, store, { storeRoot: join(dir, "store") });

      // account-only file copied in
      expect(await fsp.readFile(join(store, "-p", "only-account.jsonl"), "utf8")).toBe(
        "A"
      );
      // nested recursion
      expect(await fsp.readFile(join(store, "-p", "nested", "deep.jsonl"), "utf8")).toBe(
        "deep"
      );
      // store-only file untouched
      expect(await fsp.readFile(join(store, "-p", "only-store.jsonl"), "utf8")).toBe("S");
      // conflict: store wins, recorded
      expect(await fsp.readFile(join(store, "-p", "conflict.jsonl"), "utf8")).toBe(
        "store-version"
      );
      expect(res.conflicts).toContain(join("-p", "conflict.jsonl"));
      // identical file: no conflict
      expect(res.conflicts).not.toContain(join("-p", "same.jsonl"));
      expect(res.copied).toBeGreaterThanOrEqual(2);

      // dir mode preserved on a newly created store subdir
      const st = await fsp.stat(join(store, "-p", "nested"));
      // nested created by account default mode; -p itself already existed in store
      expect(st.isDirectory()).toBe(true);
    });
  });

  it("copies an inner symlink verbatim but skips links pointing into the store", async () => {
    await withTmpDir(async (dir) => {
      const acc = join(dir, "acc", "projects");
      const store = join(dir, "store", "projects");
      await fsp.mkdir(store, { recursive: true });
      await fsp.mkdir(acc, { recursive: true });
      // an inner symlink to a relative sibling -> copied verbatim
      await fsp.writeFile(join(acc, "real.txt"), "r");
      await fsp.symlink("real.txt", join(acc, "rel-link"));
      // a symlink pointing into the store -> skipped
      await fsp.symlink(store, join(acc, "into-store"));

      await mergeInto(acc, store, { storeRoot: join(dir, "store") });

      expect((await fsp.lstat(join(store, "rel-link"))).isSymbolicLink()).toBe(true);
      expect(await fsp.readlink(join(store, "rel-link"))).toBe("real.txt");
      const intoStore = await fsp
        .lstat(join(store, "into-store"))
        .then(() => true)
        .catch(() => false);
      expect(intoStore).toBe(false);
    });
  });
});

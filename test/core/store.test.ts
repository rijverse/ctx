import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { withTmpDir } from "../helpers/tmp.js";
import { buildAccount } from "../helpers/fakeHome.js";
import { assertStoreSafe, seedFromAccount } from "../../src/core/store.js";
import type { Account, SharedItem } from "../../src/types.js";

const ITEMS: SharedItem[] = [
  { name: "projects", kind: "dir" },
  { name: "settings.json", kind: "file" },
  { name: "todos", kind: "dir" },
];

describe("assertStoreSafe", () => {
  it("rejects home, an account dir, and a nested path", () => {
    const accounts: Account[] = [
      { name: "default", dir: "/home/u/.claude", isDefault: true },
    ];
    expect(() => assertStoreSafe("/home/u", "/home/u", accounts)).toThrow(/home/);
    expect(() => assertStoreSafe("/home/u/.claude", "/home/u", accounts)).toThrow(
      /account dir/
    );
    expect(() =>
      assertStoreSafe("/home/u/.claude/inside", "/home/u", accounts)
    ).toThrow(/inside account/);
  });

  it("accepts a separate store dir", () => {
    const accounts: Account[] = [
      { name: "default", dir: "/home/u/.claude", isDefault: true },
    ];
    expect(() =>
      assertStoreSafe("/home/u/.claude-shared", "/home/u", accounts)
    ).not.toThrow();
  });
});

describe("seedFromAccount", () => {
  it("copies present real items into empty store slots and skips the rest", async () => {
    await withTmpDir(async (dir) => {
      const src = join(dir, "src");
      const store = join(dir, "store");
      await buildAccount(src, {
        files: {
          "projects/-p/a.jsonl": "line",
          "settings.json": "{}",
        },
        symlinks: { todos: join(dir, "elsewhere") },
      });
      await fsp.mkdir(join(dir, "elsewhere"), { recursive: true });
      // store already has settings.json -> must be left alone
      await fsp.mkdir(store, { recursive: true });
      await fsp.writeFile(join(store, "settings.json"), "STORE");

      const seeded = await seedFromAccount(store, src, ITEMS);
      expect(seeded).toEqual(["projects"]); // settings present, todos is a symlink
      expect(await fsp.readFile(join(store, "projects", "-p", "a.jsonl"), "utf8")).toBe(
        "line"
      );
      expect(await fsp.readFile(join(store, "settings.json"), "utf8")).toBe("STORE");
    });
  });
});

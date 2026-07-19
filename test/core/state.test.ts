import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { withTmpDir } from "../helpers/tmp.js";
import { classifyEntry, classifyStore } from "../../src/core/state.js";

describe("classifyEntry", () => {
  it("distinguishes all six states", async () => {
    await withTmpDir(async (dir) => {
      const store = join(dir, "store", "projects");
      await fsp.mkdir(store, { recursive: true });

      // ABSENT
      expect(await classifyEntry(join(dir, "nope"), store)).toBe("ABSENT");

      // REAL_DIR / REAL_FILE
      await fsp.mkdir(join(dir, "realdir"));
      await fsp.writeFile(join(dir, "realfile"), "x");
      expect(await classifyEntry(join(dir, "realdir"), store)).toBe("REAL_DIR");
      expect(await classifyEntry(join(dir, "realfile"), store)).toBe("REAL_FILE");

      // LINKED (points at expected, target exists)
      await fsp.symlink(store, join(dir, "linked"));
      expect(await classifyEntry(join(dir, "linked"), store)).toBe("LINKED");

      // WRONG_TARGET (points elsewhere, target exists)
      const other = join(dir, "other");
      await fsp.mkdir(other);
      await fsp.symlink(other, join(dir, "wrong"));
      expect(await classifyEntry(join(dir, "wrong"), store)).toBe("WRONG_TARGET");

      // BROKEN (dangling)
      await fsp.symlink(join(dir, "gone"), join(dir, "broken"));
      expect(await classifyEntry(join(dir, "broken"), store)).toBe("BROKEN");
    });
  });
});

describe("classifyStore", () => {
  it("reports present/absent", async () => {
    await withTmpDir(async (dir) => {
      expect(await classifyStore(join(dir, "nope"))).toBe("STORE_ABSENT");
      await fsp.mkdir(join(dir, "here"));
      expect(await classifyStore(join(dir, "here"))).toBe("STORE_PRESENT");
    });
  });
});

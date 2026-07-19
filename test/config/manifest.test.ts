import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { withTmpDir } from "../helpers/tmp.js";
import { loadConfig, selectItems } from "../../src/config/manifest.js";
import { CONFIG_FILENAME } from "../../src/config/defaults.js";

async function writeStoreConfig(home: string, obj: unknown): Promise<void> {
  const store = join(home, ".claude-shared");
  await fsp.mkdir(store, { recursive: true });
  await fsp.writeFile(join(store, CONFIG_FILENAME), JSON.stringify(obj));
}

describe("loadConfig", () => {
  it("returns baked-in defaults with no config file", async () => {
    await withTmpDir(async (home) => {
      const c = await loadConfig({ home });
      expect(c.storePath).toBe(join(home, ".claude-shared"));
      expect(c.sharedNames.has("projects")).toBe(true);
      expect(c.sharedNames.has("settings.json")).toBe(true);
      expect(c.neverTouch.has(".credentials.json")).toBe(true);
      expect(c.ignore.has("cache")).toBe(true);
    });
  });

  it("lets a config file override the shared set", async () => {
    await withTmpDir(async (home) => {
      await writeStoreConfig(home, { shared: { directories: ["projects"] } });
      const c = await loadConfig({ home });
      const dirs = c.sharedItems.filter((i) => i.kind === "dir").map((i) => i.name);
      expect(dirs).toEqual(["projects"]);
      // files fall back to defaults when the file omits them
      expect(c.sharedNames.has("CLAUDE.md")).toBe(true);
    });
  });

  it("expands ~ in storePath using the provided home", async () => {
    await withTmpDir(async (home) => {
      await writeStoreConfig(home, { storePath: "~/store-elsewhere" });
      // config is read from the default store location, storePath value honored
      const c = await loadConfig({ home });
      expect(c.storePath).toBe(join(home, "store-elsewhere"));
    });
  });

  it("refuses a config that shares a protected file", async () => {
    await withTmpDir(async (home) => {
      await writeStoreConfig(home, {
        shared: { files: [".credentials.json"] },
      });
      await expect(loadConfig({ home })).rejects.toThrow(/neverTouch/);
    });
  });

  it("rejects unknown config keys", async () => {
    await withTmpDir(async (home) => {
      await writeStoreConfig(home, { bogusKey: true });
      await expect(loadConfig({ home })).rejects.toThrow(/invalid config/);
    });
  });
});

describe("selectItems", () => {
  it("returns all items with no selection", async () => {
    await withTmpDir(async (home) => {
      const c = await loadConfig({ home });
      expect(selectItems(c)).toBe(c.sharedItems);
    });
  });

  it("filters to a comma or repeated selection", async () => {
    await withTmpDir(async (home) => {
      const c = await loadConfig({ home });
      expect(selectItems(c, ["projects,settings.json"]).map((i) => i.name).sort()).toEqual([
        "projects",
        "settings.json",
      ]);
    });
  });

  it("throws on an unknown item name", async () => {
    await withTmpDir(async (home) => {
      const c = await loadConfig({ home });
      expect(() => selectItems(c, ["nope"])).toThrow(/unknown shared item/);
    });
  });
});

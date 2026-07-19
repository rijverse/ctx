import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { withTmpDir } from "../helpers/tmp.js";
import { loadConfig } from "../../src/config/manifest.js";
import { discoverAccounts, resolveAccount } from "../../src/core/accounts.js";

describe("discoverAccounts", () => {
  it("finds .claude + .claude-* dirs, excludes the store and .claude.json", async () => {
    await withTmpDir(async (home) => {
      await fsp.mkdir(join(home, ".claude"));
      await fsp.mkdir(join(home, ".claude-ekram"));
      await fsp.mkdir(join(home, ".claude-me"));
      await fsp.mkdir(join(home, ".claude-shared")); // the store
      await fsp.writeFile(join(home, ".claude.json"), "{}");
      await fsp.mkdir(join(home, "unrelated"));

      const config = await loadConfig({ home });
      const accounts = await discoverAccounts(config);
      expect(accounts.map((a) => a.name)).toEqual(["default", "ekram", "me"]);
      expect(accounts[0]?.isDefault).toBe(true);
      expect(accounts.some((a) => a.dir.endsWith(".claude-shared"))).toBe(false);
    });
  });

  it("honors an explicit accounts override", async () => {
    await withTmpDir(async (home) => {
      await fsp.mkdir(join(home, ".claude-shared"), { recursive: true });
      await fsp.writeFile(
        join(home, ".claude-shared", "ctx.config.json"),
        JSON.stringify({ accounts: [{ name: "work", dir: "~/work-cfg" }] })
      );
      const config = await loadConfig({ home });
      const accounts = await discoverAccounts(config);
      expect(accounts).toEqual([
        { name: "work", dir: join(home, "work-cfg"), isDefault: false },
      ]);
    });
  });

  it("resolveAccount throws a helpful error for unknown names", async () => {
    await withTmpDir(async (home) => {
      await fsp.mkdir(join(home, ".claude"));
      const config = await loadConfig({ home });
      await expect(resolveAccount(config, "ghost")).rejects.toThrow(/unknown account/);
    });
  });
});

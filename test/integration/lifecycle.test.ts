import { describe, it, expect } from "vitest";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { withTmpDir } from "../helpers/tmp.js";
import { buildAccount } from "../helpers/fakeHome.js";
import { loadConfig, type ResolvedConfig } from "../../src/config/manifest.js";
import { discoverAccounts, resolveAccount } from "../../src/core/accounts.js";
import { planLink, planUnlink, isMutating } from "../../src/core/plan.js";
import { applyLink } from "../../src/core/link.js";
import { applyUnlink } from "../../src/core/unlink.js";
import { mergeInto } from "../../src/core/merge.js";
import type { Account } from "../../src/types.js";

async function buildHome(home: string): Promise<void> {
  await buildAccount(join(home, ".claude"), {
    files: {
      "projects/-home-u-proj/sess1.jsonl": "default-sess",
      "projects/-home-u-proj/nested/child.jsonl": "child",
      "settings.json": "SETTINGS",
      "CLAUDE.md": "default-memory",
      "skills/s1.md": "skill",
      ".credentials.json": "DEFAULT-CREDS",
      ".claude.json": "{}",
      "cache/junk": "j",
    },
    modes: { "projects/-home-u-proj": 0o700 },
  });
  await buildAccount(join(home, ".claude-ekram"), {
    files: {
      "projects/-home-u-proj/sess2.jsonl": "ekram-sess",
      "settings.json": "SETTINGS",
      "CLAUDE.md": "ekram-memory",
      ".credentials.json": "EKRAM-CREDS",
      ".claude.json": "{}",
    },
  });
  await buildAccount(join(home, ".claude-me"), {
    files: { ".credentials.json": "ME-CREDS", ".claude.json": "{}" },
  });
}

async function runLink(
  config: ResolvedConfig,
  account: Account,
  backup = true
): Promise<ReturnType<typeof planLink> extends Promise<infer T> ? T : never> {
  const actions = await planLink(config, account, config.sharedItems);
  const backupDir = backup
    ? join(config.storePath, ".ctx-backups", account.name, "T")
    : undefined;
  await applyLink(actions, { storeRoot: config.storePath, backup, backupDir });
  return actions;
}

async function isSymlink(p: string): Promise<boolean> {
  return (await fsp.lstat(p)).isSymbolicLink();
}

describe("link/unlink lifecycle", () => {
  it("links accounts into a shared store, merges, backs up, and is idempotent", async () => {
    await withTmpDir(async (home) => {
      await buildHome(home);
      const config = await loadConfig({ home });
      const def = await resolveAccount(config, "default");
      const ekram = await resolveAccount(config, "ekram");

      // link default first: empty store -> seed everything present
      await runLink(config, def);
      expect(await isSymlink(join(def.dir, "projects"))).toBe(true);
      expect(await isSymlink(join(def.dir, "settings.json"))).toBe(true);
      // store now holds the seeded content
      expect(
        await fsp.readFile(
          join(config.storePath, "projects", "-home-u-proj", "sess1.jsonl"),
          "utf8"
        )
      ).toBe("default-sess");
      // 0700 mode preserved through the seed move
      const projMode = (await fsp.stat(join(config.storePath, "projects", "-home-u-proj")))
        .mode & 0o777;
      expect(projMode).toBe(0o700);
      // never-touch identity files remain real
      expect(await isSymlink(join(def.dir, ".credentials.json"))).toBe(false);
      expect(await isSymlink(join(def.dir, ".claude.json"))).toBe(false);
      // ignored dir left alone
      expect(await isSymlink(join(def.dir, "cache"))).toBe(false);

      // link ekram: overlapping project merges; diverged CLAUDE.md backs up
      const ekramActions = await runLink(config, ekram);
      const claudeMd = ekramActions.find((a) => a.item.name === "CLAUDE.md");
      expect(claudeMd?.action).toBe("relink");
      expect(claudeMd?.diverged).toBe(true);

      // store project dir now holds both sessions
      const merged = await fsp.readdir(
        join(config.storePath, "projects", "-home-u-proj")
      );
      expect(merged).toContain("sess1.jsonl");
      expect(merged).toContain("sess2.jsonl");
      // ekram gained skills via a pure symlink (it had none)
      expect(await isSymlink(join(ekram.dir, "skills"))).toBe(true);
      // ekram's diverged CLAUDE.md preserved in backup; store keeps default's
      expect(
        await fsp.readFile(
          join(config.storePath, ".ctx-backups", "ekram", "T", "CLAUDE.md"),
          "utf8"
        )
      ).toBe("ekram-memory");
      expect(await fsp.readFile(join(config.storePath, "CLAUDE.md"), "utf8")).toBe(
        "default-memory"
      );
      // ekram identity untouched
      expect(await fsp.readFile(join(ekram.dir, ".credentials.json"), "utf8")).toBe(
        "EKRAM-CREDS"
      );

      // idempotency: re-linking ekram changes nothing
      const again = await planLink(config, ekram, config.sharedItems);
      expect(again.filter(isMutating)).toHaveLength(0);
    });
  });

  it("unlink restores independent copies from the store", async () => {
    await withTmpDir(async (home) => {
      await buildHome(home);
      const config = await loadConfig({ home });
      const def = await resolveAccount(config, "default");
      const ekram = await resolveAccount(config, "ekram");
      await runLink(config, def);
      await runLink(config, ekram);

      const actions = await planUnlink(config, ekram, config.sharedItems);
      await applyUnlink(actions);

      // ekram projects is a real dir again, carrying the merged content
      expect(await isSymlink(join(ekram.dir, "projects"))).toBe(false);
      const proj = await fsp.readdir(join(ekram.dir, "projects", "-home-u-proj"));
      expect(proj.sort()).toEqual(["nested", "sess1.jsonl", "sess2.jsonl"]);
      // CLAUDE.md now holds the store's winning copy
      expect(await fsp.readFile(join(ekram.dir, "CLAUDE.md"), "utf8")).toBe(
        "default-memory"
      );
      // store still intact
      expect(await fsp.readFile(join(config.storePath, "CLAUDE.md"), "utf8")).toBe(
        "default-memory"
      );
      // re-running unlink is a no-op
      const again = await planUnlink(config, ekram, config.sharedItems);
      expect(again.filter(isMutating)).toHaveLength(0);
    });
  });

  it("planLink does not mutate the filesystem (dry-run safety)", async () => {
    await withTmpDir(async (home) => {
      await buildHome(home);
      const config = await loadConfig({ home });
      const def = await resolveAccount(config, "default");
      await planLink(config, def, config.sharedItems);
      // still a real dir, store never created
      expect(await isSymlink(join(def.dir, "projects"))).toBe(false);
      await expect(fsp.access(config.storePath)).rejects.toThrow();
    });
  });

  it("recovers from an interrupted run (crash after merge / after free)", async () => {
    await withTmpDir(async (home) => {
      await buildHome(home);
      const config = await loadConfig({ home });
      const def = await resolveAccount(config, "default");
      await runLink(config, def); // store seeded, default linked
      const ekram = await resolveAccount(config, "ekram");

      // Simulate crash after merge, before freeing ekram's projects dir.
      const accProjects = join(ekram.dir, "projects");
      const storeProjects = join(config.storePath, "projects");
      await mergeInto(accProjects, storeProjects, { storeRoot: config.storePath });
      // ekram/projects is still a real dir here (as if we crashed).
      expect(await isSymlink(accProjects)).toBe(false);

      // Re-run link: should complete cleanly and leave a correct symlink.
      await runLink(config, ekram);
      expect(await isSymlink(accProjects)).toBe(true);

      // Simulate crash after free, before symlink: remove the entry entirely.
      await fsp.rm(join(ekram.dir, "settings.json"), { force: true });
      const actions = await planLink(config, ekram, config.sharedItems);
      const settings = actions.find((a) => a.item.name === "settings.json");
      expect(settings?.action).toBe("adopt"); // absent + store present
      await runLink(config, ekram);
      expect(await isSymlink(join(ekram.dir, "settings.json"))).toBe(true);
    });
  });
});

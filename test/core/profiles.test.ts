import { mkdir as mkdirp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STORE, storePath } from "../../src/core/paths.js";
import { discover } from "../../src/core/profiles.js";
import { fakeHome, type FakeHome } from "../helpers/fakeHome.js";

let fh: FakeHome;
beforeEach(async () => {
  fh = await fakeHome();
});
afterEach(async () => {
  await fh.dispose();
});

const names = async (store?: string) => (await discover(store)).map((p) => p.name);

describe("discover", () => {
  it("finds ~/.claude as default plus every ~/.claude-<name>", async () => {
    await fh.profile("default", {});
    await fh.profile("me", {});
    await fh.profile("ekram", {});
    expect(await names(fh.store)).toEqual(["default", "ekram", "me"]);
  });

  it("works with no default profile at all", async () => {
    await fh.profile("me", {});
    expect(await names(fh.store)).toEqual(["me"]);
  });

  it("returns nothing when there is no Claude directory", async () => {
    expect(await names(fh.store)).toEqual([]);
  });

  it("ignores files and unrelated directories", async () => {
    await fh.profile("me", {});
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(fh.home, ".claude-notadir-parent"), { recursive: true });
    await writeFile(join(fh.home, ".claude-stray"), "not a directory");
    await mkdir(join(fh.home, "claude-no-dot"), { recursive: true });
    await mkdir(join(fh.home, ".config"), { recursive: true });
    expect(await names(fh.store)).toEqual(["me", "notadir-parent"]);
  });

  it("keeps the default store out of the profile namespace entirely", () => {
    expect(DEFAULT_STORE).toBe(".ctx-store");
    expect(DEFAULT_STORE.startsWith(".claude")).toBe(false);
    expect(storePath()).toBe(join(fh.home, ".ctx-store"));
  });

  it("never lists a store that was pointed inside the .claude-* namespace", async () => {
    await fh.profile("me", {});
    const custom = join(fh.home, ".claude-shared");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(custom, { recursive: true });

    expect(await names(custom)).toEqual(["me"]);
    expect(await names(fh.store)).toEqual(["me", "shared"]);
  });

  it("skips other tools that live in ~/.claude-* and old stores", async () => {
    await fh.profile("me", { ".claude.json": "{}" });
    await fh.profile("code-router", { "config.json": "{}", plugins: ["p.js"] });
    await fh.profile("shared", { "ctx.config.json": "{}", projects: ["a.jsonl"] });
    expect(await names(fh.store)).toEqual(["me"]);
  });
});

describe("assertStoreApart", () => {
  it("refuses a store inside a profile, or a profile inside the store", async () => {
    const { assertStoreApart } = await import("../../src/core/profiles.js");
    const { profileFromDir } = await import("../../src/core/paths.js");
    const claude = profileFromDir(join(fh.home, ".claude"));
    expect(() => assertStoreApart(join(fh.home, ".claude"), [claude])).toThrow("overlaps");
    expect(() => assertStoreApart(join(fh.home, ".claude", "store"), [claude])).toThrow("overlaps");
    expect(() => assertStoreApart(fh.home, [claude])).toThrow("overlaps");
    expect(() => assertStoreApart(fh.store, [claude])).not.toThrow();
  });

  it("names profiles by where they live, keeping default for ~/.claude alone", async () => {
    const { profileNameFromDir } = await import("../../src/core/paths.js");
    expect(profileNameFromDir(join(fh.home, ".claude"))).toBe("default");
    expect(profileNameFromDir(join(fh.home, ".claude-work"))).toBe("work");
    expect(profileNameFromDir(join(fh.home, "work", ".claude"))).toBe("work");
    expect(profileNameFromDir(join(fh.home, ".config", "claude-side"))).toBe("claude-side");
    expect(profileNameFromDir(join(fh.home, ".side"))).toBe("side");
  });
});

describe("listProfiles", () => {
  it("adds dirs from ctx.json to the discovered ones", async () => {
    const { listProfiles } = await import("../../src/core/profiles.js");
    const { defaultConfig } = await import("../../src/core/config.js");
    await fh.profile("me", {});
    const custom = join(fh.home, "work", ".claude");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(custom, { recursive: true });

    const found = await listProfiles({ ...defaultConfig(), profiles: [custom] }, fh.store);
    expect(found.map((p) => p.name)).toEqual(["me", "work"]);
    expect(found[1]!.registryPath).toBe(join(custom, ".claude.json"));
  });

  it("refuses two dirs that would share a name", async () => {
    const { listProfiles } = await import("../../src/core/profiles.js");
    const { defaultConfig } = await import("../../src/core/config.js");
    await fh.profile("work", {});
    const clash = join(fh.home, "elsewhere", ".claude-work");
    await expect(listProfiles({ ...defaultConfig(), profiles: [clash] }, fh.store)).rejects.toThrow(
      'both be called "work"',
    );
  });

});

describe("candidates", () => {
  const found = async () => {
    const { candidates, listProfiles } = await import("../../src/core/profiles.js");
    const { defaultConfig } = await import("../../src/core/config.js");
    const managed = await listProfiles(defaultConfig(), fh.store);
    return (await candidates(managed, fh.store)).map((c) => `${c.name} ${c.dir.slice(fh.home.length)} ${c.why}`);
  };
  const mkdir = (p: string) => mkdirp(p, { recursive: true });

  it("finds a config dir under any name by what it holds", async () => {
    await mkdir(join(fh.home, ".my-claude"));
    await writeFile(join(fh.home, ".my-claude", ".claude.json"), "{}");
    await mkdir(join(fh.home, "code", ".claude"));
    expect(await found()).toEqual(["my-claude /.my-claude holds .claude.json"]);
  });

  it("finds dirs that shell startup files point CLAUDE_CONFIG_DIR at", async () => {
    for (const d of ["work-cfg", ".x", ".y", ".z"]) await mkdir(join(fh.home, d));
    await writeFile(
      join(fh.home, ".zshrc"),
      [
        "alias w='CLAUDE_CONFIG_DIR=~/work-cfg claude'",
        'export CLAUDE_CONFIG_DIR="$HOME/.x"',
        "# export CLAUDE_CONFIG_DIR=~/.y",
        'echo "$CLAUDE_CONFIG_DIR" ${CLAUDE_CONFIG_DIR} unset CLAUDE_CONFIG_DIR',
      ].join("\n"),
    );
    await mkdir(join(fh.home, ".config", "fish"));
    await writeFile(join(fh.home, ".config", "fish", "config.fish"), "set -gx CLAUDE_CONFIG_DIR ~/.z\n");

    expect((await found()).sort()).toEqual([
      "work-cfg /work-cfg CLAUDE_CONFIG_DIR in ~/.zshrc",
      "x /.x CLAUDE_CONFIG_DIR in ~/.zshrc",
      "z /.z CLAUDE_CONFIG_DIR in ~/.config/fish/config.fish",
    ]);
  });

  it("finds the dir CLAUDE_CONFIG_DIR names in this shell", async () => {
    await mkdir(join(fh.home, "cfg"));
    process.env.CLAUDE_CONFIG_DIR = join(fh.home, "cfg");
    try {
      expect(await found()).toEqual(["cfg /cfg CLAUDE_CONFIG_DIR in this shell"]);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it("leaves out managed profiles, the store, missing dirs and other tools", async () => {
    await fh.profile("me", { ".claude.json": "{}" });
    await mkdir(join(fh.store));
    await writeFile(join(fh.store, ".claude.json"), "{}");
    await mkdir(join(fh.home, "tool"));
    await writeFile(join(fh.home, "tool", "config.json"), "{}");
    await writeFile(
      join(fh.home, ".bashrc"),
      `export CLAUDE_CONFIG_DIR=~/.claude-me\nexport CLAUDE_CONFIG_DIR=~/gone\nexport CLAUDE_CONFIG_DIR=~/tool\n`,
    );
    expect(await found()).toEqual([]);
  });

});

import { lstat, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply } from "../../src/core/apply.js";
import { defaultConfig, type Config } from "../../src/core/config.js";
import { profileFromDir } from "../../src/core/paths.js";
import { planDetach, planSync } from "../../src/core/plan.js";
import { pull, push, readSlice } from "../../src/core/session.js";
import { fakeHome, type FakeHome } from "../helpers/fakeHome.js";

let fh: FakeHome;
let config: Config;

beforeEach(async () => {
  fh = await fakeHome();
  config = { ...defaultConfig(), shared: ["projects", "skills", "settings.json", "history.jsonl"] };
});
afterEach(async () => {
  await fh.dispose();
});

const sync = async (name: string) => {
  const profile = profileFromDir(
    join(fh.home, name === "default" ? ".claude" : `.claude-${name}`),
  );
  return apply(await planSync(profile, fh.store, config), fh.store, config);
};

describe("two profiles sharing one store", () => {
  it("puts both profiles' sessions behind one directory", async () => {
    await fh.profile("default", { projects: ["work.jsonl"], "settings.json": '{"model":"a"}' });
    await fh.profile("me", { projects: ["side.jsonl"] });

    await sync("default");
    await sync("me");

    const stored = await readdir(join(fh.store, "projects"));
    expect(stored.sort()).toEqual(["side.jsonl", "work.jsonl"]);

    for (const dir of [".claude", ".claude-me"]) {
      const link = await lstat(join(fh.home, dir, "projects"));
      expect(link.isSymbolicLink()).toBe(true);
      expect((await readdir(join(fh.home, dir, "projects"))).sort()).toEqual([
        "side.jsonl",
        "work.jsonl",
      ]);
    }
  });

  it("makes a new session visible to the other profile immediately", async () => {
    await fh.profile("default", { projects: ["a.jsonl"] });
    await fh.profile("me", {});
    await sync("default");
    await sync("me");

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(fh.home, ".claude-me", "projects", "fresh.jsonl"), "hi");

    expect(await readdir(join(fh.home, ".claude", "projects"))).toContain("fresh.jsonl");
  });

  it("keeps the store copy and backs up the loser when a file collides", async () => {
    await fh.profile("default", { "settings.json": '{"model":"first"}' });
    await fh.profile("me", { "settings.json": '{"model":"second"}' });

    await sync("default");
    const result = await sync("me");

    expect(await readFile(join(fh.store, "settings.json"), "utf8")).toBe('{"model":"first"}');
    expect(result.backups).toHaveLength(1);
    expect(await readFile(result.backups[0]!, "utf8")).toBe('{"model":"second"}');
  });

  it("unions directories and backs up only the colliding files", async () => {
    await fh.profile("default", { skills: ["shared.md", "mine.md"] });
    await fh.profile("me", { skills: ["shared.md", "theirs.md"] });

    await sync("default");
    const result = await sync("me");

    expect((await readdir(join(fh.store, "skills"))).sort()).toEqual([
      "mine.md",
      "shared.md",
      "theirs.md",
    ]);
    expect(await readFile(join(fh.store, "skills", "shared.md"), "utf8")).toBe("default:shared.md");
    expect(result.collisions).toHaveLength(1);
  });

  it("is safe to run twice", async () => {
    await fh.profile("default", { projects: ["a.jsonl"] });
    await sync("default");
    const second = await sync("default");
    expect(second.done).toBe(0);
    expect(await readdir(join(fh.store, "projects"))).toEqual(["a.jsonl"]);
  });
});

describe("identity", () => {
  it("never moves or links a credential file", async () => {
    await fh.profile("default", {
      projects: ["a.jsonl"],
      ".credentials.json": '{"token":"secret"}',
      "policy-limits.json": "{}",
    });
    await sync("default");

    const creds = join(fh.home, ".claude", ".credentials.json");
    expect((await lstat(creds)).isSymbolicLink()).toBe(false);
    expect(await readFile(creds, "utf8")).toBe('{"token":"secret"}');
    await expect(lstat(join(fh.store, ".credentials.json"))).rejects.toThrow();
    await expect(lstat(join(fh.store, "policy-limits.json"))).rejects.toThrow();
  });

  it("leaves machine-local caches alone", async () => {
    await fh.profile("default", { cache: ["blob"], sessions: ["s"], projects: ["a.jsonl"] });
    await sync("default");
    expect((await lstat(join(fh.home, ".claude", "cache"))).isDirectory()).toBe(true);
    await expect(lstat(join(fh.store, "cache"))).rejects.toThrow();
  });
});

describe("the .claude.json split", () => {
  it("shares project trust but not the login", async () => {
    await fh.registry("default", {
      oauthAccount: { emailAddress: "one@example.com" },
      userID: "user-one",
      projects: { "/work/app": { hasTrustDialogAccepted: true } },
      mcpServers: { linear: { url: "https://mcp.linear.app" } },
    });
    await fh.registry("me", {
      oauthAccount: { emailAddress: "two@example.com" },
      userID: "user-two",
      projects: {},
    });

    const first = profileFromDir(join(fh.home, ".claude"));
    const second = profileFromDir(join(fh.home, ".claude-me"));

    await push(first, fh.store, config);
    await pull(second, fh.store, config);

    const after = JSON.parse(await readFile(second.registryPath, "utf8"));
    expect(after.oauthAccount).toEqual({ emailAddress: "two@example.com" });
    expect(after.userID).toBe("user-two");
    expect(after.projects["/work/app"].hasTrustDialogAccepted).toBe(true);
    expect(after.mcpServers.linear).toBeDefined();
  });

  it("writes the composed registry with the same mode Claude uses", async () => {
    await fh.registry("me", { userID: "u" });
    const profile = profileFromDir(join(fh.home, ".claude-me"));
    await pull(profile, fh.store, config);
    expect((await lstat(profile.registryPath)).mode & 0o777).toBe(0o600);
  });

  it("carries work done in one profile over to the next", async () => {
    await fh.registry("me", { projects: { "/a": { hasTrustDialogAccepted: true } } });
    await fh.registry("ekram", { oauthAccount: { emailAddress: "e@x.com" } });

    const me = profileFromDir(join(fh.home, ".claude-me"));
    const ekram = profileFromDir(join(fh.home, ".claude-ekram"));

    await push(me, fh.store, config);
    await pull(ekram, fh.store, config);

    const after = JSON.parse(await readFile(ekram.registryPath, "utf8"));
    expect(after.projects["/a"].hasTrustDialogAccepted).toBe(true);
    expect(after.oauthAccount.emailAddress).toBe("e@x.com");
  });

  it("does not let one profile's push erase another's projects", async () => {
    await fh.registry("me", { projects: { "/a": {} } });
    await fh.registry("ekram", { projects: { "/b": {} } });
    await push(profileFromDir(join(fh.home, ".claude-me")), fh.store, config);
    await push(profileFromDir(join(fh.home, ".claude-ekram")), fh.store, config);

    const slice = await readSlice(fh.store);
    expect(Object.keys(slice.data.projects as object).sort()).toEqual(["/a", "/b"]);
  });

  const me = () => profileFromDir(join(fh.home, ".claude-me"));
  const readReg = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const editReg = async (path: string, fn: (j: Record<string, any>) => void) => {
    const j = await readReg(path);
    fn(j);
    await writeFile(path, JSON.stringify(j));
  };

  it("keeps what a profile changed before the pull instead of overwriting it", async () => {
    const path = await fh.registry("me", { userID: "u", mcpServers: { foo: {} }, projects: { "/a": {} } });
    await pull(me(), fh.store, config);

    // A session started without ctx run adds a server and trusts a repo.
    await editReg(path, (j) => {
      j.mcpServers.bar = {};
      j.projects["/b"] = { hasTrustDialogAccepted: true };
    });
    await pull(me(), fh.store, config);

    const after = await readReg(path);
    expect(Object.keys(after.mcpServers).sort()).toEqual(["bar", "foo"]);
    expect(after.projects["/b"].hasTrustDialogAccepted).toBe(true);
  });

  it("makes a removal stick across push and pull, in every profile", async () => {
    const mine = await fh.registry("me", { mcpServers: { foo: {}, bar: {} }, projects: { "/a": {} } });
    const theirs = await fh.registry("ekram", { projects: { "/a": {} } });
    const ekram = profileFromDir(join(fh.home, ".claude-ekram"));
    await pull(me(), fh.store, config);
    await pull(ekram, fh.store, config);
    expect(Object.keys((await readReg(theirs)).mcpServers).sort()).toEqual(["bar", "foo"]);

    await editReg(mine, (j) => delete j.mcpServers.foo);
    await push(me(), fh.store, config);
    await pull(me(), fh.store, config);
    await pull(ekram, fh.store, config);

    expect(Object.keys((await readReg(mine)).mcpServers)).toEqual(["bar"]);
    expect(Object.keys((await readReg(theirs)).mcpServers)).toEqual(["bar"]);
  });

  it("refuses to touch a .claude.json it cannot parse", async () => {
    await fh.registry("default", { projects: { "/a": {} } });
    await push(profileFromDir(join(fh.home, ".claude")), fh.store, config);
    const before = await readFile(join(fh.store, "registry.json"), "utf8");

    const broken = '{"oauthAccount":{"emailAddress":"me@x"},"primaryApiKey":"sk-x",';
    await mkdir(join(fh.home, ".claude-me"), { recursive: true });
    await writeFile(me().registryPath, broken);

    await expect(pull(me(), fh.store, config)).rejects.toThrow("not valid JSON");
    await expect(push(me(), fh.store, config)).rejects.toThrow("not valid JSON");
    expect(await readFile(me().registryPath, "utf8")).toBe(broken);
    expect(await readFile(join(fh.store, "registry.json"), "utf8")).toBe(before);
  });

  it("restores a reset profile from the store instead of spreading the reset", async () => {
    const path = await fh.registry("me", {
      userID: "u",
      hasCompletedOnboarding: true,
      projects: { "/a": { hasTrustDialogAccepted: true } },
      mcpServers: { foo: {} },
    });
    await pull(me(), fh.store, config);

    // What a wiped .claude.json looks like once Claude has written its defaults.
    await writeFile(path, JSON.stringify({ userID: "new", hasCompletedOnboarding: false, projects: {} }));
    expect((await push(me(), fh.store, config)).reset).toBe(true);
    expect((await readSlice(fh.store)).data.mcpServers).toEqual({ foo: {} });

    const pulled = await pull(me(), fh.store, config);
    expect(pulled.reset).toBe(true);
    const after = await readReg(path);
    expect(after.userID).toBe("new");
    expect(after.hasCompletedOnboarding).toBe(true);
    expect(after.projects["/a"].hasTrustDialogAccepted).toBe(true);
    expect(after.mcpServers).toEqual({ foo: {} });
  });

  it("waits for Claude's own lock on .claude.json before writing it", async () => {
    const path = await fh.registry("me", { userID: "u" });
    await mkdir(`${path}.lock`);
    let released = false;
    setTimeout(() => {
      released = true;
      void rm(`${path}.lock`, { recursive: true });
    }, 300);

    await pull(me(), fh.store, config);
    expect(released).toBe(true);
  });

  it("takes over a .claude.json lock that Claude abandoned", async () => {
    const path = await fh.registry("me", { userID: "u" });
    await mkdir(`${path}.lock`);
    const old = new Date(Date.now() - 60_000);
    await utimes(`${path}.lock`, old, old);

    await pull(me(), fh.store, config);
    await expect(lstat(`${path}.lock`)).rejects.toThrow();
  });

  it("keeps the store's copy of the registry private, like .claude.json", async () => {
    await fh.registry("me", { mcpServers: { s: { env: { API_KEY: "k" } } } });
    await push(me(), fh.store, config);
    expect((await lstat(join(fh.store, "registry.json"))).mode & 0o777).toBe(0o600);
  });

  it("puts the default profile's registry at ~/.claude.json, not inside the dir", async () => {
    const path = await fh.registry("default", { userID: "u" });
    expect(path).toBe(join(fh.home, ".claude.json"));
    expect(profileFromDir(join(fh.home, ".claude")).registryPath).toBe(path);
  });
});

describe("detach", () => {
  it("hands back real copies that no longer follow the store", async () => {
    await fh.profile("default", { projects: ["a.jsonl"] });
    await fh.profile("me", {});
    await sync("default");
    await sync("me");

    const me = profileFromDir(join(fh.home, ".claude-me"));
    await apply(await planDetach(me, fh.store, config), fh.store, config);

    const entry = join(fh.home, ".claude-me", "projects");
    expect((await lstat(entry)).isSymbolicLink()).toBe(false);
    expect(await readdir(entry)).toEqual(["a.jsonl"]);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(fh.store, "projects", "later.jsonl"), "x");
    expect(await readdir(entry)).toEqual(["a.jsonl"]);
  });

  it("leaves the store intact so other profiles keep working", async () => {
    await fh.profile("default", { projects: ["a.jsonl"] });
    await fh.profile("me", {});
    await sync("default");
    await sync("me");
    await apply(
      await planDetach(profileFromDir(join(fh.home, ".claude-me")), fh.store, config),
      fh.store,
      config,
    );
    expect(await readdir(join(fh.home, ".claude", "projects"))).toEqual(["a.jsonl"]);
  });
});

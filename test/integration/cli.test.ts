import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTime } from "../../src/util/proc.js";
import { fakeHome, type FakeHome } from "../helpers/fakeHome.js";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

let fh: FakeHome;

/** Runs the built CLI against the throwaway home, never the real one. */
async function ctx(...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, CTX_HOME: fh.home, NO_COLOR: "1" },
    });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: (err.stdout ?? "") + (err.stderr ?? ""), code: err.code ?? 1 };
  }
}

beforeEach(async () => {
  fh = await fakeHome();
  await fh.profile("default", { projects: ["a.jsonl"], skills: ["s.md"], ".credentials.json": "{}" });
  await fh.profile("me", { projects: ["b.jsonl"], ".credentials.json": "{}" });
  await fh.registry("default", { userID: "one", projects: { "/p": { hasTrustDialogAccepted: true } } });
  await fh.registry("me", { userID: "two", oauthAccount: { emailAddress: "me@x.test" } });
});
afterEach(async () => {
  await fh.dispose();
});

describe("ctx CLI", () => {
  it("refuses to work before init", async () => {
    const { stdout, code } = await ctx("status");
    expect(code).toBe(1);
    expect(stdout).toContain("No store");
  });

  it("walks init, sync and status", async () => {
    expect((await ctx("init", "-y")).stdout).toContain("Created");
    expect((await ctx("sync", "--all", "-y")).stdout).toContain("Done.");

    const state = JSON.parse((await ctx("status", "--json")).stdout);
    for (const p of state.profiles) expect(p.items.projects).toBe("linked");

    for (const dir of [".claude", ".claude-me"]) {
      expect((await lstat(join(fh.home, dir, "projects"))).isSymbolicLink()).toBe(true);
      expect((await lstat(join(fh.home, dir, ".credentials.json"))).isSymbolicLink()).toBe(false);
    }
  });

  it("changes nothing on --dry-run", async () => {
    await ctx("init", "-y");
    const { stdout } = await ctx("sync", "--all", "--dry-run");
    expect(stdout).toContain("nothing was changed");
    expect((await lstat(join(fh.home, ".claude", "projects"))).isSymbolicLink()).toBe(false);
  });

  it("emits parseable json", async () => {
    await ctx("init", "-y");
    await ctx("sync", "--all", "-y");
    const parsed = JSON.parse((await ctx("status", "--json")).stdout);
    expect(parsed.initialized).toBe(true);
    expect(parsed.profiles.map((p: { name: string }) => p.name).sort()).toEqual(["default", "me"]);
    expect(parsed.profiles[0].items.projects).toBe("linked");
  });

  it("keeps each profile's login through a registry pull", async () => {
    await ctx("init", "-y");
    await ctx("sync", "--all", "-y");
    await ctx("registry", "pull", "me");

    const after = JSON.parse(await readFile(join(fh.home, ".claude-me", ".claude.json"), "utf8"));
    expect(after.userID).toBe("two");
    expect(after.oauthAccount.emailAddress).toBe("me@x.test");
    expect(after.projects["/p"].hasTrustDialogAccepted).toBe(true);
  });

  it("repairs a broken link and says so", async () => {
    await ctx("init", "-y");
    await ctx("sync", "--all", "-y");

    const { rm, symlink } = await import("node:fs/promises");
    await rm(join(fh.home, ".claude-me", "projects"));
    await symlink(join(fh.home, "gone"), join(fh.home, ".claude-me", "projects"));

    const before = JSON.parse((await ctx("status", "--json")).stdout);
    expect(before.profiles.find((p: { name: string }) => p.name === "me").items.projects).toBe(
      "dangling",
    );

    expect((await ctx("doctor", "-y")).stdout).toContain("repaired");

    const after = JSON.parse((await ctx("status", "--json")).stdout);
    for (const p of after.profiles) expect(p.items.projects).toBe("linked");
  });

  it("round-trips sync and detach", async () => {
    await ctx("init", "-y");
    await ctx("sync", "--all", "-y");
    await ctx("detach", "me", "-y");
    expect((await lstat(join(fh.home, ".claude-me", "projects"))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(fh.home, ".claude", "projects"))).isSymbolicLink()).toBe(true);
  });

  it("restricts itself with --only", async () => {
    await ctx("init", "-y");
    await ctx("sync", "default", "--only", "skills", "-y");
    expect((await lstat(join(fh.home, ".claude", "skills"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(fh.home, ".claude", "projects"))).isSymbolicLink()).toBe(false);
  });

  it("names an unknown profile instead of guessing", async () => {
    await ctx("init", "-y");
    const { stdout, code } = await ctx("sync", "nope", "-y");
    expect(code).toBe(1);
    expect(stdout).toContain("unknown profile");
  });

  it("launches claude with CLAUDE_CONFIG_DIR set, then folds the session back", async () => {
    await ctx("init", "-y");
    await ctx("sync", "--all", "-y");

    const bin = join(fh.home, "bin");
    await mkdir(bin, { recursive: true });
    const stub = join(bin, "claude");
    await writeFile(
      stub,
      [
        "#!/bin/sh",
        'printf "%s" "$CLAUDE_CONFIG_DIR" > "$CLAUDE_CONFIG_DIR/../seen"',
        `node -e 'const f=process.env.CLAUDE_CONFIG_DIR+"/.claude.json",fs=require("fs");` +
          `const j=JSON.parse(fs.readFileSync(f,"utf8"));j.projects["/new"]={hasTrustDialogAccepted:true};` +
          `fs.writeFileSync(f,JSON.stringify(j))'`,
      ].join("\n"),
      { mode: 0o755 },
    );

    const { stdout } = await run(process.execPath, [CLI, "run", "me"], {
      env: { ...process.env, CTX_HOME: fh.home, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH}` },
    });
    expect(stdout).not.toContain("not on your PATH");
    expect(await readFile(join(fh.home, "seen"), "utf8")).toBe(join(fh.home, ".claude-me"));

    const slice = JSON.parse(await readFile(join(fh.home, ".ctx-store", "registry.json"), "utf8"));
    expect(slice.data.projects["/new"].hasTrustDialogAccepted).toBe(true);
  });

  it("reports usage per account before there is a store, without asking for a login it lacks", async () => {
    await fh.profile("stale", {
      ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: 1, subscriptionType: "pro" } }),
    });

    const { stdout, code } = await ctx("usage", "--json");
    expect(code).toBe(0);
    const byName = Object.fromEntries(
      JSON.parse(stdout).profiles.map((p: { name: string; state: string }) => [p.name, p]),
    );
    expect(byName.default.state).toBe("none");
    expect(byName.me).toMatchObject({ state: "none", account: "me@x.test" });
    expect(byName.stale).toMatchObject({ state: "expired", plan: "pro" });

    const text = await ctx("usage", "stale");
    expect(text.stdout).toContain("login expired");
    expect(text.stdout).not.toContain("me@x.test");
    expect((await ctx("usage", "nope")).stdout).toContain("unknown profile");
  });

  it("survives a closed pipe", async () => {
    await ctx("init", "-y");
    const { stdout } = await run("/bin/sh", ["-c", `node ${CLI} status | head -2`], {
      env: { ...process.env, CTX_HOME: fh.home, NO_COLOR: "1" },
    });
    expect(stdout).not.toContain("EPIPE");
  });

  /** Make it look like claude is running in a profile, as this test process. */
  async function liveSession(dir: string, pid = process.pid): Promise<void> {
    await mkdir(join(fh.home, dir, "sessions"), { recursive: true });
    const procStart = (await startTime(pid)) ?? "0";
    await writeFile(join(fh.home, dir, "sessions", `${pid}.json`), JSON.stringify({ procStart }));
  }

  it("stops claude in a profile before moving its data, and says so", async () => {
    await ctx("init", "-y");
    const { spawn } = await import("node:child_process");
    const sleeper = spawn("sleep", ["60"]);
    const exited = new Promise((r) => sleeper.once("exit", r));
    await liveSession(".claude-me", sleeper.pid!);

    const { stdout, code } = await ctx("sync", "--all", "-y");
    expect(code).toBe(0);
    expect(stdout).toContain(`warning: stopping claude in me (pid ${sleeper.pid}`);
    await exited;
    expect(sleeper.signalCode).toBe("SIGTERM");
    expect((await lstat(join(fh.home, ".claude-me", "projects"))).isSymbolicLink()).toBe(true);
  });

  it("never stops the session ctx itself runs from", async () => {
    await ctx("init", "-y");
    // The test runner is an ancestor of the ctx it starts, like a claude
    // session is of a ctx run from its shell.
    await liveSession(".claude-me");

    const { stdout, code } = await ctx("sync", "--all", "-y");
    expect(code).toBe(0);
    expect(stdout).toContain("is the session running ctx, so it keeps running");
    expect(stdout).not.toContain("warning: stopping");
    expect((await lstat(join(fh.home, ".claude-me", "projects"))).isSymbolicLink()).toBe(true);
  });

  it("ignores session files left behind by a claude that is gone", async () => {
    await ctx("init", "-y");
    await liveSession(".claude-me", 999999999);
    expect((await ctx("sync", "--all", "-y")).code).toBe(0);
  });

  it("flags a link that something replaced with a real file", async () => {
    await ctx("init", "-y");
    await fh.profile("default", { "settings.json": "{}" });
    await ctx("sync", "--all", "-y");

    const { rm } = await import("node:fs/promises");
    await rm(join(fh.home, ".claude-me", "settings.json"));
    await writeFile(join(fh.home, ".claude-me", "settings.json"), '{"edited":true}');

    const { stdout, code } = await ctx("doctor");
    expect(code).toBe(1);
    expect(stdout).toContain("unlinked");
    expect(stdout).toContain("ctx sync me");
  });

  it("installs a hook that carries a custom store, and removes only its own", async () => {
    const store = join(fh.home, "elsewhere");
    await ctx("init", "-y", "--store", store);
    await ctx("sync", "--all", "-y", "--store", store);

    const settingsPath = join(store, "settings.json");
    const userHook = { type: "command", command: "echo my hook end marker" };
    await writeFile(settingsPath, JSON.stringify({ hooks: { SessionEnd: [{ hooks: [userHook] }] } }));

    expect((await ctx("hooks", "install", "-y", "--store", store)).stdout).toContain("Installed");
    const installed = JSON.parse(await readFile(settingsPath, "utf8"));
    const ours = installed.hooks.SessionEnd.flatMap((g: { hooks: { command: string }[] }) => g.hooks)
      .map((h: { command: string }) => h.command)
      .find((c: string) => c.includes("cli.js"));
    expect(ours).toContain(`--store '${store}'`);
    expect((await ctx("hooks", "install", "-y", "--store", store)).stdout).toContain("Already installed");

    await ctx("hooks", "uninstall", "-y", "--store", store);
    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(after.hooks.SessionEnd).toEqual([{ hooks: [userHook] }]);
  });

  it("refuses to install the hook where no profile would load it", async () => {
    await ctx("init", "-y", "--only", "projects");
    const { stdout, code } = await ctx("hooks", "install", "-y");
    expect(code).toBe(1);
    expect(stdout).toContain("settings.json is not shared");
  });

  it("still launches claude when .claude.json cannot be read, and leaves it alone", async () => {
    await ctx("init", "-y");
    await ctx("sync", "--all", "-y");
    const broken = '{"userID":"two",';
    await writeFile(join(fh.home, ".claude-me", ".claude.json"), broken);

    const bin = join(fh.home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), '#!/bin/sh\ntouch "$CLAUDE_CONFIG_DIR/../launched"\n', { mode: 0o755 });

    const { stdout } = await run(process.execPath, [CLI, "run", "me"], {
      env: { ...process.env, CTX_HOME: fh.home, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH}` },
    });
    expect(stdout).toContain("skipped the registry pull");
    expect(await readFile(join(fh.home, "launched"), "utf8")).toBe("");
    expect(await readFile(join(fh.home, ".claude-me", ".claude.json"), "utf8")).toBe(broken);
  });

  it("passes claude's exit code through", async () => {
    await ctx("init", "-y");
    const bin = join(fh.home, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    const code = await run(process.execPath, [CLI, "run", "me"], {
      env: { ...process.env, CTX_HOME: fh.home, NO_COLOR: "1", PATH: `${bin}:${process.env.PATH}` },
    }).then(
      () => 0,
      (e: { code?: number }) => e.code,
    );
    expect(code).toBe(7);
  });

  it("keeps what other profiles folded in when init --force rewrites the config", async () => {
    await ctx("init", "-y");
    await ctx("sync", "--all", "-y");
    await fh.registry("me", { userID: "two", projects: { "/m": {} } });
    await ctx("registry", "push", "me");

    await ctx("init", "-y", "--force");
    const after = JSON.parse(await readFile(join(fh.home, ".ctx-store", "registry.json"), "utf8"));
    expect(Object.keys(after.data.projects).sort()).toEqual(["/m", "/p"]);
  });

  it("reports running sessions in status --json", async () => {
    await ctx("init", "-y");
    await liveSession(".claude-me");
    const parsed = JSON.parse((await ctx("status", "--json")).stdout);
    expect(parsed.profiles.find((p: { name: string }) => p.name === "me").running).toEqual([process.pid]);
  });

  it("manages a profile dir with any name once it is added", async () => {
    await ctx("init", "-y");
    const custom = join(fh.home, "work", ".claude");
    await mkdir(join(custom, "projects"), { recursive: true });
    await writeFile(join(custom, "projects", "w.jsonl"), "w");

    expect((await ctx("add", custom)).stdout).toContain("added work");
    expect((await ctx("add", custom)).stdout).toContain("already managed");
    expect((await ctx("sync", "--all", "-y")).code).toBe(0);

    expect((await lstat(join(custom, "projects"))).isSymbolicLink()).toBe(true);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(join(fh.home, ".claude", "projects"))).sort()).toEqual(["a.jsonl", "b.jsonl", "w.jsonl"]);
  });

  it("sets up from custom dirs alone with init --add", async () => {
    const { rm } = await import("node:fs/promises");
    await rm(join(fh.home, ".claude"), { recursive: true });
    await rm(join(fh.home, ".claude-me"), { recursive: true });
    await rm(join(fh.home, ".claude.json"));
    const a = join(fh.home, "accounts", "alpha");
    const b = join(fh.home, "accounts", "beta");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });

    const unsure = await ctx("init", "-y", "--add", `${a},${b}`);
    expect(unsure.code).toBe(1);
    expect(unsure.stdout).toContain("--from");

    expect((await ctx("init", "-y", "--add", `${a},${b}`, "--from", "beta")).code).toBe(0);
    const config = JSON.parse(await readFile(join(fh.home, ".ctx-store", "ctx.json"), "utf8"));
    expect(config.seed).toBe("beta");
    expect(config.profiles).toEqual([a, b]);
  });

  it("syncs the seed first, so its files win whatever the order", async () => {
    const { rm } = await import("node:fs/promises");
    await rm(join(fh.home, ".claude"), { recursive: true });
    await rm(join(fh.home, ".claude.json"));
    await fh.profile("alpha", { "settings.json": '{"who":"alpha"}' });
    await fh.profile("me", { "settings.json": '{"who":"me"}' });

    await ctx("init", "-y", "--from", "me");
    await ctx("sync", "--all", "-y");
    expect(await readFile(join(fh.home, ".ctx-store", "settings.json"), "utf8")).toBe('{"who":"me"}');
  });

  it("syncs an unsynced seed first rather than letting another profile win over it", async () => {
    await fh.profile("default", { "settings.json": '{"who":"default"}' });
    await fh.profile("me", { "settings.json": '{"who":"me"}' });
    await ctx("init", "-y");

    const run = await ctx("sync", "me", "-y");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("default seeds the store and is not synced yet, so it is synced first");
    expect(await readFile(join(fh.home, ".ctx-store", "settings.json"), "utf8")).toBe('{"who":"default"}');
    for (const d of [".claude", ".claude-me"]) {
      expect((await lstat(join(fh.home, d, "settings.json"))).isSymbolicLink()).toBe(true);
    }
  });


  it("resolves a name clash with --as, and the hook finds the profile by its new name", async () => {
    await ctx("init", "-y");
    const clash = join(fh.home, "clients", ".claude-me");
    await mkdir(clash, { recursive: true });
    await writeFile(join(clash, ".claude.json"), JSON.stringify({ projects: { "/client": {} } }));

    const refused = await ctx("add", clash);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain('both be called "me"');

    expect((await ctx("add", clash, "--as", "client")).stdout).toContain("added client");
    const names = JSON.parse((await ctx("status", "--json")).stdout).profiles.map((p: { name: string }) => p.name);
    expect(names).toEqual(["default", "me", "client"]);

    await run(process.execPath, [CLI, "hook", "end"], {
      env: { ...process.env, CTX_HOME: fh.home, CLAUDE_CONFIG_DIR: clash },
    });
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(fh.home, ".ctx-store", ".bases"))).toContain("client.json");
  });

  it("refuses names that would not make safe paths", async () => {
    await ctx("init", "-y");
    const { stdout, code } = await ctx("add", join(fh.home, ".claude-me"), "--as", "../up");
    expect(code).toBe(1);
    expect(stdout).toContain("not a usable name");
  });


  it("points at a config dir with another name instead of guessing", async () => {
    const custom = join(fh.home, ".my-claude");
    await mkdir(custom, { recursive: true });
    await writeFile(join(custom, ".claude.json"), JSON.stringify({ projects: {} }));
    await ctx("init", "-y");

    const status = await ctx("status");
    expect(status.stdout).toContain("Claude dirs not managed");
    expect(status.stdout).toContain("~/.my-claude");
    expect(JSON.parse((await ctx("status", "--json")).stdout).unmanaged[0].name).toBe("my-claude");

    const run = await ctx("run", "my-claude");
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("ctx add ~/.my-claude");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(fh.home)).not.toContain(".claude-my-claude");

    await ctx("add", custom);
    expect(JSON.parse((await ctx("status", "--json")).stdout).unmanaged).toEqual([]);
  });

  it("asks for --add when the only config dir has another name", async () => {
    const { rm } = await import("node:fs/promises");
    for (const d of [".claude", ".claude-me"]) await rm(join(fh.home, d), { recursive: true });
    await rm(join(fh.home, ".claude.json"));
    const custom = join(fh.home, ".my-claude");
    await mkdir(custom, { recursive: true });
    await writeFile(join(custom, ".claude.json"), "{}");

    const unsure = await ctx("init", "-y");
    expect(unsure.code).toBe(1);
    expect(unsure.stdout).toContain("--add ~/.my-claude");

    expect((await ctx("init", "-y", "--add", custom)).code).toBe(0);
    const config = JSON.parse(await readFile(join(fh.home, ".ctx-store", "ctx.json"), "utf8"));
    expect(config.seed).toBe("my-claude");
  });


  describe("starting from nothing", () => {
    /** A claude that writes a first session the way the real one lays it out. */
    async function fakeClaude(): Promise<string> {
      const bin = join(fh.home, "bin");
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(bin, "claude"),
        [
          "#!/bin/sh",
          'd="$CLAUDE_CONFIG_DIR"',
          'mkdir -p "$d/projects/-app"',
          'echo "{}" > "$d/projects/-app/$FAKE_WHO.jsonl"',
          'echo "{\\"who\\":\\"$FAKE_WHO\\"}" >> "$d/history.jsonl"',
          '[ -e "$d/settings.json" ] || echo "{\\"theme\\":\\"$FAKE_WHO\\"}" > "$d/settings.json"',
          'echo "{\\"token\\":\\"$FAKE_WHO\\"}" > "$d/.credentials.json"',
        ].join("\n"),
        { mode: 0o755 },
      );
      return bin;
    }
    const launch = (bin: string, who: string, ...argv: string[]) =>
      run(process.execPath, [CLI, "run", ...argv], {
        env: { ...process.env, CTX_HOME: fh.home, NO_COLOR: "1", FAKE_WHO: who, PATH: `${bin}:${process.env.PATH}` },
      });

    beforeEach(async () => {
      const { rm } = await import("node:fs/promises");
      for (const d of [".claude", ".claude-me"]) await rm(join(fh.home, d), { recursive: true });
      await rm(join(fh.home, ".claude.json"));
    });

    it("creates an empty store with no seed yet", async () => {
      const { stdout, code } = await ctx("init", "-y");
      expect(code).toBe(0);
      expect(stdout).toContain("starts empty");
      const config = JSON.parse(await readFile(join(fh.home, ".ctx-store", "ctx.json"), "utf8"));
      expect(config.seed).toBeUndefined();
    });

    it("links every account from its first session, and the first one seeds", async () => {
      await ctx("init", "-y");
      const bin = await fakeClaude();

      const first = await launch(bin, "alice", "default");
      expect(first.stdout).toContain("into the store and linked");
      const config = JSON.parse(await readFile(join(fh.home, ".ctx-store", "ctx.json"), "utf8"));
      expect(config.seed).toBe("default");

      const second = await launch(bin, "bob", "work");
      expect(second.stdout).toContain("linked projects");

      for (const d of [".claude", ".claude-work"]) {
        for (const item of ["projects", "history.jsonl", "settings.json"]) {
          expect((await lstat(join(fh.home, d, item))).isSymbolicLink()).toBe(true);
        }
        expect((await lstat(join(fh.home, d, ".credentials.json"))).isSymbolicLink()).toBe(false);
      }
      const { readdir } = await import("node:fs/promises");
      expect((await readdir(join(fh.home, ".ctx-store", "projects", "-app"))).sort()).toEqual(["alice.jsonl", "bob.jsonl"]);
      expect(await readFile(join(fh.home, ".ctx-store", "settings.json"), "utf8")).toContain("alice");
      expect(await readFile(join(fh.home, ".claude-work", ".credentials.json"), "utf8")).toContain("bob");
    });

    it("leaves a profile that was detached on purpose alone", async () => {
      await ctx("init", "-y");
      const bin = await fakeClaude();
      await launch(bin, "alice", "default");
      await launch(bin, "bob", "work");
      await ctx("detach", "work", "-y");

      const again = await launch(bin, "bob", "work");
      expect(again.stdout).toContain("work is not synced into the store yet");
      expect((await lstat(join(fh.home, ".claude-work", "projects"))).isSymbolicLink()).toBe(false);
    });
  });


  it("links what a later profile brought in to the ones synced before it", async () => {
    await fh.profile("me", { plans: ["p.md"] });
    await ctx("init", "-y");
    await ctx("sync", "--all", "-y");
    expect((await lstat(join(fh.home, ".claude", "plans"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(fh.home, ".claude-me", "skills"))).isSymbolicLink()).toBe(true);
  });

});

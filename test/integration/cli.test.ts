import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  it("survives a closed pipe", async () => {
    await ctx("init", "-y");
    const { stdout } = await run("/bin/sh", ["-c", `node ${CLI} status | head -2`], {
      env: { ...process.env, CTX_HOME: fh.home, NO_COLOR: "1" },
    });
    expect(stdout).not.toContain("EPIPE");
  });
});

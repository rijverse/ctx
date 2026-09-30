import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config.js";
import { planDetach, planSync, stateOf } from "../../src/core/plan.js";
import { profileFromDir } from "../../src/core/paths.js";
import { fakeHome, type FakeHome } from "../helpers/fakeHome.js";

let fh: FakeHome;
beforeEach(async () => {
  fh = await fakeHome();
});
afterEach(async () => {
  await fh.dispose();
});

describe("stateOf", () => {
  it("reports absent, file and dir", async () => {
    const dir = await fh.profile("default", { "a.txt": "x", sub: ["one"] });
    expect(await stateOf(join(dir, "missing"), "/nowhere")).toBe("absent");
    expect(await stateOf(join(dir, "a.txt"), "/nowhere")).toBe("file");
    expect(await stateOf(join(dir, "sub"), "/nowhere")).toBe("dir");
  });

  it("tells a correct link from one pointing elsewhere", async () => {
    const dir = await fh.profile("default", {});
    await mkdir(join(fh.store, "projects"), { recursive: true });
    await mkdir(join(fh.home, "decoy"), { recursive: true });
    await symlink(join(fh.store, "projects"), join(dir, "good"));
    await symlink(join(fh.home, "decoy"), join(dir, "bad"));
    expect(await stateOf(join(dir, "good"), join(fh.store, "projects"))).toBe("linked");
    expect(await stateOf(join(dir, "bad"), join(fh.store, "projects"))).toBe("misdirected");
  });

  it("reports a link whose target is gone", async () => {
    const dir = await fh.profile("default", {});
    await symlink(join(fh.store, "vanished"), join(dir, "projects"));
    expect(await stateOf(join(dir, "projects"), join(fh.store, "vanished"))).toBe("dangling");
  });
});

describe("planSync", () => {
  const config = { ...defaultConfig(), shared: ["projects", "settings.json", "skills"] };

  it("seeds into an empty store", async () => {
    const dir = await fh.profile("default", { projects: ["a.jsonl"] });
    const plan = await planSync(profileFromDir(dir), fh.store, config);
    expect(kinds(plan)).toEqual({ projects: "seed" });
  });

  it("absorbs a directory the store already has", async () => {
    const dir = await fh.profile("default", { projects: ["a.jsonl"] });
    await mkdir(join(fh.store, "projects"), { recursive: true });
    const plan = await planSync(profileFromDir(dir), fh.store, config);
    expect(kinds(plan)).toEqual({ projects: "absorb" });
  });

  it("stashes a file the store already has", async () => {
    const dir = await fh.profile("default", { "settings.json": "{}" });
    await mkdir(fh.store, { recursive: true });
    await writeFile(join(fh.store, "settings.json"), "{}");
    const plan = await planSync(profileFromDir(dir), fh.store, config);
    expect(kinds(plan)).toEqual({ "settings.json": "stash" });
  });

  it("just attaches when the profile has nothing", async () => {
    const dir = await fh.profile("second", {});
    await mkdir(join(fh.store, "projects"), { recursive: true });
    const plan = await planSync(profileFromDir(dir), fh.store, config);
    expect(kinds(plan)).toEqual({ projects: "attach" });
  });

  it("does nothing for an item absent on both sides", async () => {
    const dir = await fh.profile("default", {});
    const plan = await planSync(profileFromDir(dir), fh.store, config);
    expect(plan.effective).toHaveLength(0);
  });

  it("honours --only", async () => {
    const dir = await fh.profile("default", { projects: ["a"], skills: ["b"] });
    const plan = await planSync(profileFromDir(dir), fh.store, config, ["skills"]);
    expect(kinds(plan)).toEqual({ skills: "seed" });
  });

  it("ignores an item that is not shareable even if asked directly", async () => {
    const dir = await fh.profile("default", { ".credentials.json": "{}" });
    const plan = await planSync(profileFromDir(dir), fh.store, config, [".credentials.json"]);
    expect(plan.steps).toHaveLength(0);
  });
});

describe("planDetach", () => {
  it("only detaches what is actually linked and backed by the store", async () => {
    const config = { ...defaultConfig(), shared: ["projects", "skills"] };
    const dir = await fh.profile("default", { skills: ["own"] });
    await mkdir(join(fh.store, "projects"), { recursive: true });
    await symlink(join(fh.store, "projects"), join(dir, "projects"));
    const plan = await planDetach(profileFromDir(dir), fh.store, config);
    expect(kinds(plan)).toEqual({ projects: "detach" });
  });
});

function kinds(plan: { effective: { item: { name: string }; kind: string }[] }) {
  return Object.fromEntries(plan.effective.map((s) => [s.item.name, s.kind]));
}

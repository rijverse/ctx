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
});

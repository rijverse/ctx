import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withLock } from "../../src/util/lock.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ctx-lock-"));
}

describe("withLock", () => {
  it("never lets two writers hold it at once", async () => {
    const dir = join(await scratch(), "lock");
    let holders = 0;
    let peak = 0;

    // Which writer wins the mkdir race is undefined, so the invariant is the
    // count of simultaneous holders, never the order they arrive in. The delay
    // is the overlap window: without it a broken lock would still look serial.
    const task = () =>
      withLock(dir, async () => {
        peak = Math.max(peak, ++holders);
        await new Promise((r) => setTimeout(r, 30));
        holders--;
      });

    await Promise.all([task(), task(), task()]);
    expect(peak).toBe(1);
    expect(holders).toBe(0);
  });

  it("releases the lock when the body throws", async () => {
    const dir = join(await scratch(), "lock");
    await expect(withLock(dir, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(withLock(dir, async () => "second")).resolves.toBe("second");
  });

  it("reclaims a lock whose holder is gone", async () => {
    const dir = join(await scratch(), "lock");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pid"), "999999999 0\n");
    await expect(withLock(dir, async () => "took it")).resolves.toBe("took it");
    await rm(dir, { recursive: true, force: true });
  });
});

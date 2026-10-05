import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFileLock, withLock } from "../../src/util/lock.js";
import { startTime } from "../../src/util/proc.js";

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

  it("reclaims a lock left by a dead holder in the current format", async () => {
    const root = await scratch();
    const dir = join(root, "lock");
    await mkdir(dir);
    await writeFile(join(dir, "owner"), "999999999 123 abcd");
    await expect(withLock(dir, async () => "took it")).resolves.toBe("took it");
    expect(await readdir(root)).toEqual([]);
  });

  it("never takes a lock from a live holder", async () => {
    const dir = join(await scratch(), "lock");
    await mkdir(dir);
    await writeFile(join(dir, "owner"), `${process.pid} ${(await startTime(process.pid)) ?? "-"} live`);
    await expect(withLock(dir, async () => "stole it", 300)).rejects.toThrow("another ctx");
  });

  it("treats a recycled pid as a different process", async () => {
    const dir = join(await scratch(), "lock");
    await mkdir(dir);
    // Same pid, different start time: whoever wrote this is gone.
    await writeFile(join(dir, "owner"), `${process.pid} 1 recycled`);
    const ours = await startTime(process.pid);
    if (ours === undefined) return; // no /proc to tell them apart
    await expect(withLock(dir, async () => "took it", 300)).resolves.toBe("took it");
  });

  it("is re-entrant within one call chain", async () => {
    const dir = join(await scratch(), "lock");
    const inner = await withLock(dir, () => withLock(dir, async () => "nested", 300), 300);
    expect(inner).toBe("nested");
  });

  it("takes over an ownerless lock dir, which only an earlier build could leave", async () => {
    const dir = join(await scratch(), "lock");
    await mkdir(dir);
    await expect(withLock(dir, async () => "took it", 300)).resolves.toBe("took it");
  });
});

describe("withFileLock", () => {
  it("excludes a second holder while the first works", async () => {
    const file = join(await scratch(), ".claude.json");
    let holders = 0;
    let peak = 0;
    const task = () =>
      withFileLock(file, async () => {
        peak = Math.max(peak, ++holders);
        await new Promise((r) => setTimeout(r, 30));
        holders--;
      });
    await Promise.all([task(), task(), task()]);
    expect(peak).toBe(1);
  });

  it("gives up on a fresh lock it cannot get", async () => {
    const file = join(await scratch(), ".claude.json");
    await mkdir(`${file}.lock`);
    await expect(withFileLock(file, async () => "x", 300)).rejects.toThrow("locked by a running claude");
  });
});

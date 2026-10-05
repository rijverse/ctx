import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSameProcess, startTime } from "./proc.js";
import { CtxError } from "./ui.js";

const WAIT_MS = 15_000;
const OWNER = "owner";
/** proper-lockfile's default, which is what Claude uses for .claude.json. */
const FILE_LOCK_STALE_MS = 10_000;

const held = new AsyncLocalStorage<Set<string>>();

/**
 * Store lock. The lock directory is built under a temporary name and renamed
 * into place, so nobody ever sees it without its owner file, and a rename onto
 * a non-empty directory fails, which is what makes taking it atomic.
 *
 * A dead holder is recognised by pid and process start time, not by age: a sync
 * moving a big tree across devices can legitimately hold the lock for minutes.
 *
 * Re-entrant within one async call chain, so `ctx sync` can hold it across
 * apply and the registry push that follows.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>, waitMs = WAIT_MS): Promise<T> {
  const mine = held.getStore();
  if (mine?.has(dir) === true) return fn();

  const token = `${process.pid} ${(await startTime(process.pid)) ?? "-"} ${randomBytes(4).toString("hex")}`;
  const deadline = Date.now() + waitMs;
  await mkdir(dirname(dir), { recursive: true });

  while (!(await tryAcquire(dir, token))) {
    const owner = await readOwner(dir);
    if (owner !== undefined && (await isStale(owner))) {
      await reclaim(dir, owner);
      continue;
    }
    if (Date.now() > deadline) {
      const pid = owner?.split(" ")[0];
      throw new CtxError(`another ctx is using the store${pid ? ` (pid ${pid})` : ""}. Try again once it finishes.`);
    }
    await sleep(100);
  }

  try {
    return await held.run(new Set([...(mine ?? []), dir]), fn);
  } finally {
    await release(dir, token);
  }
}

/**
 * Move the lock aside before deleting it. Deleting in place would empty the
 * directory first, and a rename onto an empty directory succeeds, so another
 * process could take the lock halfway through and have it removed under it.
 */
async function release(dir: string, token: string): Promise<void> {
  if ((await readOwner(dir)) !== token) return;
  const tomb = `${dir}.done-${randomBytes(4).toString("hex")}`;
  await rename(dir, tomb);
  await rm(tomb, { recursive: true, force: true });
}

async function tryAcquire(dir: string, token: string): Promise<boolean> {
  const tmp = `${dir}.${randomBytes(6).toString("hex")}`;
  await mkdir(tmp);
  try {
    await writeFile(join(tmp, OWNER), token);
    await rename(tmp, dir);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY" || code === "EEXIST") return false;
    throw e;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The owner token, "" for a lock dir without one, undefined when unlocked. */
async function readOwner(dir: string): Promise<string | undefined> {
  // "pid" is where earlier builds wrote the holder.
  for (const name of [OWNER, "pid"]) {
    try {
      return (await readFile(join(dir, name), "utf8")).trim();
    } catch {
      /* try the next one */
    }
  }
  try {
    await stat(dir);
    return "";
  } catch {
    return undefined;
  }
}

async function isStale(owner: string): Promise<boolean> {
  // Only an earlier build, dying between its mkdir and its pid write, leaves a
  // lock dir with no owner. A rename would replace an empty dir anyway.
  if (owner === "") return true;
  const [pidText, started] = owner.split(" ");
  const pid = Number(pidText);
  // Earlier builds wrote "<pid> <epoch ms>" where the start time goes now.
  const known = started !== undefined && started !== "-" && !/^\d{13}$/.test(started) ? started : undefined;
  return !(await isSameProcess(pid, known));
}

/**
 * Move a dead holder's lock aside. Two waiters can both decide the same lock is
 * stale, so whoever moves it checks it moved the lock it looked at, and puts it
 * back if it turns out to be a fresh one someone took in between.
 */
async function reclaim(dir: string, owner: string): Promise<void> {
  const tomb = `${dir}.stale-${randomBytes(4).toString("hex")}`;
  try {
    await rename(dir, tomb);
  } catch {
    return;
  }
  if ((await readOwner(tomb)) === owner) {
    await rm(tomb, { recursive: true, force: true });
    return;
  }
  try {
    await rename(tomb, dir);
  } catch {
    await rm(tomb, { recursive: true, force: true });
  }
}

/**
 * Take the lock Claude itself takes before saving .claude.json, so a pull never
 * lands in the middle of Claude's read-modify-write. Claude uses proper-lockfile
 * with `<file>.lock`, a bare directory whose mtime the holder refreshes, and
 * treats one older than ten seconds as abandoned. This does the same.
 */
export async function withFileLock<T>(file: string, fn: () => Promise<T>, waitMs = WAIT_MS): Promise<T> {
  const dir = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  await mkdir(dirname(file), { recursive: true });

  for (;;) {
    try {
      await mkdir(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if ((await ageOf(dir)) > FILE_LOCK_STALE_MS) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) {
      throw new CtxError(`${file} stayed locked by a running claude. Try again in a moment.`);
    }
    await sleep(100);
  }

  try {
    return await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function ageOf(dir: string): Promise<number> {
  try {
    return Date.now() - (await stat(dir)).mtimeMs;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

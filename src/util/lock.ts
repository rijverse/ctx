import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir } from "./fsx.js";

const STALE_MS = 30_000;

/**
 * Directory-based lock. mkdir is atomic on every filesystem we care about, and
 * the pid file lets a crashed run's lock be reclaimed instead of wedging the
 * store forever.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await ensureDir(join(dir, ".."));
  const pidFile = join(dir, "pid");

  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (await isStale(pidFile)) {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      if (attempt >= 60) throw new Error(`could not acquire lock at ${dir}`);
      await sleep(250);
    }
  }

  try {
    await writeFile(pidFile, `${process.pid} ${Date.now()}\n`);
    return await fn();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function isStale(pidFile: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(pidFile, "utf8");
  } catch {
    // A holder that died between mkdir and writing its pid would otherwise wedge
    // the store forever, so fall back to the lock directory's own age.
    try {
      const { mtimeMs } = await stat(dirname(pidFile));
      return Date.now() - mtimeMs > STALE_MS;
    } catch {
      return false;
    }
  }
  const [pidText, atText] = raw.trim().split(/\s+/);
  const pid = Number(pidText);
  const at = Number(atText);
  if (Number.isFinite(pid) && alive(pid)) return false;
  return !Number.isFinite(at) || Date.now() - at > STALE_MS;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process is there, we just cannot signal it.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

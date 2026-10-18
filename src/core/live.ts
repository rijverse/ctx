import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Profile } from "../types.js";
import { ancestors, cwdOf, isSameProcess, stopProcesses } from "../util/proc.js";

/**
 * Pids of the claude sessions running in a profile right now. Claude writes
 * sessions/<pid>.json when a session starts, with the process start time in
 * `procStart`, and does not always clean up after a crash, so a file only
 * counts while its pid is alive and still the same process.
 */
export async function liveSessions(profile: Profile): Promise<number[]> {
  const dir = join(profile.dir, "sessions");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const live: number[] = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (m === null) continue;
    const pid = Number(m[1]);
    let started: string | undefined;
    try {
      const meta = JSON.parse(await readFile(join(dir, name), "utf8")) as { procStart?: unknown };
      if (typeof meta.procStart === "string") started = meta.procStart;
    } catch {
      /* half-written or foreign: fall back to the pid alone */
    }
    if (await isSameProcess(pid, started)) live.push(pid);
  }
  return live.sort((a, b) => a - b);
}

export interface Running {
  profile: Profile;
  pid: number;
  cwd?: string;
  /** The session ctx was started from. Stopping it would stop ctx too. */
  self: boolean;
}

export async function findRunning(profiles: Profile[]): Promise<Running[]> {
  const mine = await ancestors();
  const found: Running[] = [];
  for (const profile of profiles) {
    for (const pid of await liveSessions(profile)) {
      found.push({ profile, pid, cwd: await cwdOf(pid), self: mine.has(pid) });
    }
  }
  return found;
}

/** Stop every session in the list except ctx's own. Returns the ones still alive. */
export async function stopRunning(running: Running[]): Promise<Running[]> {
  const targets = running.filter((r) => !r.self);
  if (targets.length === 0) return [];
  const left = new Set(await stopProcesses(targets.map((r) => r.pid)));
  return targets.filter((r) => left.has(r.pid));
}

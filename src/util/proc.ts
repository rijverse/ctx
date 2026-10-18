import { execFileSync } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process is there, we just cannot signal it.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kernel start time of a process, field 22 of /proc/<pid>/stat. Together with
 * the pid it names one process for good, so a recycled pid is not mistaken for
 * the one that wrote a lock or a session file. Undefined where there is no /proc.
 */
export async function startTime(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // The command name in field 2 can contain spaces and parentheses.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** True when `pid` is running and, where it can be checked, is the same process. */
export async function isSameProcess(pid: number, started: string | undefined): Promise<boolean> {
  if (!isAlive(pid)) return false;
  if (started === undefined) return true;
  const now = await startTime(pid);
  return now === undefined || now === started;
}

async function parentOf(pid: number): Promise<number | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    /* no /proc, ask ps */
  }
  try {
    const ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This process and everything above it. ctx started from a shell inside a
 * claude session has that session among its ancestors, and stopping it would
 * take ctx down halfway through.
 */
export async function ancestors(): Promise<Set<number>> {
  const seen = new Set<number>();
  for (let pid: number | undefined = process.pid; pid !== undefined && pid > 1 && !seen.has(pid); ) {
    seen.add(pid);
    pid = await parentOf(pid);
  }
  return seen;
}

/** Where a process is working, when the platform says. */
export async function cwdOf(pid: number): Promise<string | undefined> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

/**
 * Ask each process to exit with SIGTERM, which lets claude finish writing its
 * transcript, then SIGKILL whatever is still there after the grace period.
 * Returns the pids that outlived both.
 */
export async function stopProcesses(pids: number[], graceMs = 5000): Promise<number[]> {
  const send = (sig: NodeJS.Signals, to: number[]) => {
    for (const pid of to) {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  send("SIGTERM", pids);
  let left = await waitForExit(pids, graceMs);
  if (left.length > 0) {
    send("SIGKILL", left);
    left = await waitForExit(left, 2000);
  }
  return left;
}

async function waitForExit(pids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  let left = pids.filter(isAlive);
  while (left.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    left = left.filter(isAlive);
  }
  return left;
}

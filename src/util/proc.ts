import { readFile } from "node:fs/promises";

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

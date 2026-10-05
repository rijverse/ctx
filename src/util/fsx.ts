import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CtxError } from "./ui.js";

export async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function linkTarget(p: string): Promise<string | undefined> {
  try {
    const st = await lstat(p);
    if (!st.isSymbolicLink()) return undefined;
    return await readlink(p);
  } catch {
    return undefined;
  }
}

/** Compare two paths after resolving symlinks, tolerating missing targets. */
export async function samePath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

/**
 * Write via a sibling temp file so a crash cannot leave a half-written file.
 * A symlink is written through rather than replaced. An existing file keeps its
 * mode, and a `mode` passed in is a ceiling as well as the mode for a new file,
 * so a file holding secrets is never left more open than asked.
 */
export async function writeAtomic(p: string, data: string, mode?: number): Promise<void> {
  const target = await followLink(p);
  await ensureDir(dirname(target));
  let keep = mode ?? 0o644;
  try {
    const existing = (await stat(target)).mode & 0o777;
    keep = mode === undefined ? existing : existing & mode;
  } catch {
    /* new file */
  }
  const tmp = `${target}.ctx-tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await writeFile(tmp, data, { mode: keep });
    // writeFile's mode goes through the umask. This one is meant exactly.
    await chmod(tmp, keep);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function followLink(p: string): Promise<string> {
  const target = await linkTarget(p);
  if (target === undefined) return p;
  return isAbsolute(target) ? target : resolve(dirname(p), target);
}

/**
 * Undefined only when the file does not exist. A file that is there but does
 * not parse is an error, never "empty": treating it as empty is how a caller
 * ends up writing a fresh file over the one it could not read.
 */
export async function readJson<T>(p: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new CtxError(`${p} is not valid JSON (${(e as Error).message}), so it was left untouched`);
  }
}

export async function writeJson(p: string, value: unknown, mode?: number): Promise<void> {
  await writeAtomic(p, JSON.stringify(value, null, 2) + "\n", mode);
}

/** Move across devices too: rename first, fall back to copy-then-remove. */
export async function move(from: string, to: string): Promise<void> {
  await ensureDir(dirname(to));
  try {
    await rename(from, to);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw e;
  }
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
  await rm(from, { recursive: true, force: true });
}

export async function copyInto(from: string, to: string): Promise<void> {
  await ensureDir(dirname(to));
  await cp(from, to, { recursive: true, dereference: true, force: true });
}

/**
 * Point `at` at `target`. An existing link is swapped with a rename, so there
 * is no moment where the path is missing and a running claude could create a
 * real directory in its place. Anything at `at` that is not a link is refused.
 */
export async function replaceSymlink(at: string, target: string): Promise<void> {
  await ensureDir(dirname(at));
  if ((await linkTarget(at)) === undefined) {
    try {
      await symlink(target, at);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      throw new CtxError(`${at} appeared while it was being linked, so it was left as it is. Is claude running there?`);
    }
    return;
  }
  const tmp = `${at}.ctx-link-${process.pid}`;
  await rm(tmp, { force: true });
  await symlink(target, tmp);
  await rename(tmp, at);
}

/** Remove the directories under `dir` that hold no files. Never removes a file. */
export async function removeEmptyDirs(dir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) await removeEmptyDirs(join(dir, e.name));
  }
  try {
    await rmdir(dir);
  } catch {
    /* not empty, which is the point */
  }
}

/**
 * Merge `from` into `to` without ever clobbering: a path already present in the
 * destination is left as it is and reported back, so the caller can decide
 * whether that counts as a conflict worth mentioning.
 */
export async function mergeTree(from: string, to: string): Promise<string[]> {
  const kept: string[] = [];
  await ensureDir(to);
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      if (await isDir(dst)) {
        kept.push(...(await mergeTree(src, dst)));
      } else if (await exists(dst)) {
        kept.push(dst);
      } else {
        await move(src, dst);
      }
      continue;
    }
    if (await exists(dst)) {
      kept.push(dst);
    } else {
      await move(src, dst);
    }
  }
  return kept;
}

export async function dirSize(p: string): Promise<number> {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        try {
          total += (await lstat(full)).size;
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  return total;
}

export async function isWritable(p: string): Promise<boolean> {
  try {
    await access(p, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

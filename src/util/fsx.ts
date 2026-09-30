import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

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

/** Write via a sibling temp file so a crash cannot leave a half-written file. */
export async function writeAtomic(p: string, data: string, mode = 0o644): Promise<void> {
  await ensureDir(dirname(p));
  const tmp = `${p}.ctx-tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, p);
}

export async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function writeJson(p: string, value: unknown, mode = 0o644): Promise<void> {
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

export async function replaceSymlink(at: string, target: string): Promise<void> {
  await ensureDir(dirname(at));
  const st = await linkTarget(at);
  if (st !== undefined) await rm(at, { force: true });
  await symlink(target, at);
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

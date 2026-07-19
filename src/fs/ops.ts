import { createReadStream } from "node:fs";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

export async function mkdirp(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

/** lstat without throwing on ENOENT (returns null when the path is absent). */
export async function lstatSafe(p: string) {
  try {
    return await fsp.lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** True if anything (file, dir, or symlink incl. broken) exists at `p`. */
export async function pathExists(p: string): Promise<boolean> {
  return (await lstatSafe(p)) !== null;
}

/** sha256 of a file's contents, hex. */
export async function hashFile(p: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((res, rej) => {
    const s = createReadStream(p);
    s.on("error", rej);
    s.on("data", (chunk) => hash.update(chunk));
    s.on("end", () => res());
  });
  return hash.digest("hex");
}

/**
 * Recursively copy a file or directory, preserving mode and mtime and copying
 * symlinks verbatim (never dereferencing them).
 */
export async function copyRecursive(src: string, dst: string): Promise<void> {
  await fsp.cp(src, dst, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

export async function removeRecursive(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}

/** Move, falling back to copy+remove across filesystems (EXDEV). */
export async function moveWithExdevFallback(
  src: string,
  dst: string
): Promise<void> {
  await mkdirp(dirname(dst));
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await copyRecursive(src, dst);
    await removeRecursive(src);
  }
}

/**
 * Create a symlink at `linkPath` pointing to `target`, swapping it into place
 * atomically. `linkPath` must not be an existing directory (remove/move it
 * first); an existing file or symlink there is replaced.
 */
export async function atomicSymlink(
  target: string,
  linkPath: string
): Promise<void> {
  const dir = dirname(linkPath);
  await mkdirp(dir);
  const tmp = join(
    dir,
    `.ctx-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fsp.symlink(target, tmp);
  try {
    await fsp.rename(tmp, linkPath);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Read a symlink's target resolved to an absolute path. */
export async function readLinkAbs(linkPath: string): Promise<string> {
  const target = await fsp.readlink(linkPath);
  return target.startsWith("/") ? target : join(dirname(linkPath), target);
}

import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";

export interface FakeAccountSpec {
  /** relpath -> file content */
  files?: Record<string, string>;
  /** relpaths of empty directories to create */
  dirs?: string[];
  /** relpath -> symlink target (absolute or relative to the link) */
  symlinks?: Record<string, string>;
  /** relpaths (dirs) to chmod, applied after creation */
  modes?: Record<string, number>;
}

/** Materialize an account config dir from a declarative spec. */
export async function buildAccount(
  dir: string,
  spec: FakeAccountSpec
): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  for (const d of spec.dirs ?? []) {
    await fsp.mkdir(join(dir, d), { recursive: true });
  }
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const p = join(dir, rel);
    await fsp.mkdir(dirname(p), { recursive: true });
    await fsp.writeFile(p, content);
  }
  for (const [rel, target] of Object.entries(spec.symlinks ?? {})) {
    const p = join(dir, rel);
    await fsp.mkdir(dirname(p), { recursive: true });
    await fsp.symlink(target, p);
  }
  for (const [rel, mode] of Object.entries(spec.modes ?? {})) {
    await fsp.chmod(join(dir, rel), mode);
  }
}

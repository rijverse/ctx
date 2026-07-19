import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run `fn` with a fresh temp directory, cleaned up afterward. */
export async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(join(tmpdir(), "ctx-test-"));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

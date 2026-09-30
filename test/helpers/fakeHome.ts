import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeHome {
  home: string;
  store: string;
  dispose(): Promise<void>;
  /** Create a profile dir with some content. "default" means ~/.claude. */
  profile(name: string, layout: Record<string, string | string[]>): Promise<string>;
  registry(name: string, value: unknown): Promise<string>;
}

export async function fakeHome(): Promise<FakeHome> {
  const home = await mkdtemp(join(tmpdir(), "ctx-test-"));
  process.env.CTX_HOME = home;
  const store = join(home, ".ctx-store");

  const dirFor = (name: string) => join(home, name === "default" ? ".claude" : `.claude-${name}`);

  return {
    home,
    store,
    async dispose() {
      delete process.env.CTX_HOME;
      await rm(home, { recursive: true, force: true });
    },
    async profile(name, layout) {
      const dir = dirFor(name);
      await mkdir(dir, { recursive: true });
      for (const [path, content] of Object.entries(layout)) {
        const full = join(dir, path);
        if (Array.isArray(content)) {
          await mkdir(full, { recursive: true });
          for (const child of content) await writeFile(join(full, child), `${name}:${child}`);
        } else {
          await mkdir(join(full, ".."), { recursive: true });
          await writeFile(full, content);
        }
      }
      return dir;
    },
    async registry(name, value) {
      const dir = dirFor(name);
      await mkdir(dir, { recursive: true });
      const path = name === "default" ? join(home, ".claude.json") : join(dir, ".claude.json");
      await writeFile(path, JSON.stringify(value, null, 2));
      return path;
    },
  };
}

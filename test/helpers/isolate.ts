import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Every test file starts with HOME pointed at a throwaway directory and a fake
// claude first on PATH, so a test that forgets CTX_HOME still cannot reach the
// real ~/.claude* or launch the real claude.
const sandbox = mkdtempSync(join(tmpdir(), "ctx-sandbox-"));
const bin = join(sandbox, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

process.env.HOME = sandbox;
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
for (const name of ["CTX_HOME", "CTX_STORE", "CLAUDE_CONFIG_DIR"]) delete process.env[name];

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

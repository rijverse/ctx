import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolName } from "../schema/portable.js";

/**
 * Claude Code stores projects under ~/.claude/projects/<encodedCwd>/
 * where the encoded cwd is the absolute path with each `/` replaced by `-`.
 * Example: /home/robert/www/context -> -home-robert-www-context
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function decodeCwd(encoded: string): string {
  // An encoded path starts with `-` to stand in for the leading `/`.
  if (!encoded.startsWith("-")) return encoded;
  return "/" + encoded.slice(1).replace(/-/g, "/");
}

export function claudeRoot(): string {
  return join(homedir(), ".claude");
}

export function pukuRoot(): string {
  return join(homedir(), ".puku-cli");
}

export function geminiRoot(): string {
  return join(homedir(), ".gemini");
}

export function codexRoot(): string {
  return join(homedir(), ".codex");
}

/** Map a tool name to its on-disk root directory. Throws for tools without
 *  an obvious root (Aider stores state inside the project, not $HOME). */
export function toolRoot(tool: ToolName): string {
  switch (tool) {
    case "claude":
      return claudeRoot();
    case "puku":
      return pukuRoot();
    case "gemini":
      return geminiRoot();
    case "codex":
      return codexRoot();
    case "aider":
      throw new Error("Aider does not have a $HOME-relative storage root");
  }
}

export function projectsDir(root: string, cwd: string): string {
  return join(root, "projects", encodeCwd(cwd));
}

export function sessionFilePath(
  root: string,
  cwd: string,
  sessionId: string
): string {
  return join(projectsDir(root, cwd), `${sessionId}.jsonl`);
}

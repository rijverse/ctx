import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeClaudeEvents,
  type ClaudeEvent,
  type NormalizedSession,
} from "../normalizers/claude-jsonl.js";
import { readJsonlStream } from "../io/readJsonlStream.js";
import { projectsDir } from "../io/paths.js";
import type {
  Adapter,
  BuildOptions,
  DetectionResult,
  ImportOptions,
  ImportResult,
  SessionRef,
} from "./types.js";
import type { PortableMessage, PortableSession, ToolName } from "../schema/portable.js";
import { makePortableSession } from "../schema/portable.js";
import { writeNativeClaudeSession } from "../render/native-claude.js";
import { redactMessage } from "./redact.js";

/**
 * Shared base for Claude Code and puku-cli. Both CLIs use the same JSONL
 * schema under `projects/<encodedCwd>/<sessionId>.jsonl`. The only
 * difference between adapters is the root directory.
 */
export abstract class ClaudeFamilyAdapter implements Adapter {
  abstract readonly tool: ToolName;
  protected abstract root(): string;

  async canHandle(cwd: string): Promise<DetectionResult> {
    const dir = projectsDir(this.root(), cwd);
    const cues: string[] = [];
    let confidence = 0;

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // dir doesn't exist, leave confidence at 0
      return { confidence, cues };
    }

    confidence = 0.8;
    cues.push(`found ${dir}`);
    const jsonls = entries.filter((e) => e.endsWith(".jsonl"));
    if (jsonls.length > 0) {
      confidence = 0.99;
      cues.push(`found ${jsonls.length} session file(s)`);
    }

    return { confidence, cues };
  }

  async *listSessions(cwd: string): AsyncIterable<SessionRef> {
    const dir = projectsDir(this.root(), cwd);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.replace(/\.jsonl$/, "");
      const filePath = join(dir, name);
      try {
        const st = await stat(filePath);
        yield {
          id: sessionId,
          cwd,
          sizeBytes: st.size,
          mtime: st.mtime.toISOString(),
        };
      } catch {
        // skip files we can't stat
      }
    }
  }

  async *exportSession(ref: SessionRef): AsyncIterable<PortableMessage> {
    const normalized = await this.readAndNormalize(ref);
    for (const msg of normalized.messages) {
      yield msg;
    }
  }

  async buildPortableSession(
    ref: SessionRef,
    opts: BuildOptions = {}
  ): Promise<PortableSession> {
    const normalized = await this.readAndNormalize(ref);
    const messages = opts.redact
      ? normalized.messages.map(redactMessage)
      : normalized.messages;

    return makePortableSession({
      source: { tool: this.tool, version: normalized.version },
      session: {
        id: normalized.id,
        started_at: normalized.startedAt,
        cwd: normalized.cwd || ref.cwd,
        git_branch: normalized.gitBranch,
        model: normalized.model,
      },
      messages,
    });
  }

  async importSession(
    session: PortableSession,
    opts: ImportOptions
  ): Promise<ImportResult> {
    const { filePath } = await writeNativeClaudeSession(
      session,
      this.tool,
      opts.targetCwd,
      { dryRun: opts.dryRun }
    );
    return { writtenFiles: [filePath] };
  }

  /**
   * Load events from disk and run the normalizer. Both exportSession and
   * buildPortableSession funnel through here so they stay equivalent.
   */
  private async readAndNormalize(ref: SessionRef): Promise<NormalizedSession> {
    const filePath = join(projectsDir(this.root(), ref.cwd), `${ref.id}.jsonl`);
    const events: ClaudeEvent[] = [];
    for await (const ev of readJsonlStream<ClaudeEvent>(filePath)) {
      events.push(ev);
    }
    return normalizeClaudeEvents(events);
  }
}
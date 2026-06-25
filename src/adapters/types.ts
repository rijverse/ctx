import type { PortableMessage, PortableSession, ToolName } from "../schema/portable.js";

export interface DetectionResult {
  /** 0..1, higher means stronger evidence this adapter owns the cwd */
  confidence: number;
  /** Human-readable hints explaining the score */
  cues: string[];
}

export interface SessionRef {
  id: string;
  cwd: string;
  startedAt?: string;
  model?: string;
  sizeBytes: number;
  mtime: string;
}

export interface ImportOptions {
  targetCwd: string;
  writeNative: boolean;
  dryRun: boolean;
}

export interface ImportResult {
  writtenFiles: string[];
}

export interface BuildOptions {
  redact?: boolean;
}

export interface Adapter {
  readonly tool: ToolName;

  canHandle(cwd: string): Promise<DetectionResult>;

  listSessions(cwd: string): AsyncIterable<SessionRef>;

  /**
   * Stream a session's messages in portable form. The caller wraps this in
   * the full PortableSession envelope.
   */
  exportSession(ref: SessionRef): AsyncIterable<PortableMessage>;

  /**
   * Build the full PortableSession envelope. Streaming-only adapters can
   * throw UnsupportedOperationError.
   */
  buildPortableSession(
    ref: SessionRef,
    opts?: BuildOptions
  ): Promise<PortableSession>;

  importSession(
    session: PortableSession,
    opts: ImportOptions
  ): Promise<ImportResult>;
}

export class UnsupportedOperationError extends Error {
  constructor(adapter: ToolName, op: string) {
    super(`Adapter "${adapter}" does not support ${op}`);
    this.name = "UnsupportedOperationError";
  }
}
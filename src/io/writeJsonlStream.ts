import { createWriteStream } from "node:fs";
import type { Writable } from "node:stream";

/**
 * Write JSONL: each call to `write` appends one record followed by a newline.
 * Always close with `end()` (use the `Symbol.asyncDispose` interface or
 * explicit `.end()`).
 */
export class JsonlWriter {
  private readonly stream: Writable;
  private closed = false;

  constructor(filePath: string) {
    this.stream = createWriteStream(filePath, { encoding: "utf8" });
  }

  write(record: unknown): void {
    if (this.closed) throw new Error("JsonlWriter is closed");
    this.stream.write(JSON.stringify(record) + "\n");
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
}

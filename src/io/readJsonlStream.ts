import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/**
 * Stream a JSONL file one parsed record at a time. Bad lines are skipped
 * (logged via the optional `onError` callback) so a single corrupt line
 * does not abort an entire multi-MB session.
 */
export async function* readJsonlStream<T = unknown>(
  filePath: string,
  opts: { onError?: (err: unknown, line: string) => void } = {}
): AsyncIterable<T> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  yield* readJsonlFromStream<T>(stream, opts);
}

export async function* readJsonlFromStream<T = unknown>(
  stream: Readable,
  opts: { onError?: (err: unknown, line: string) => void } = {}
): AsyncIterable<T> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch (err) {
      if (opts.onError) opts.onError(err, trimmed);
    }
  }
}

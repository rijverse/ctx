const color = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const wrap = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = wrap("2");
export const bold = wrap("1");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const blue = wrap("34");
export const cyan = wrap("36");

/**
 * Piping into `head` closes the pipe under us. Node turns that into an
 * unhandled EPIPE and a stack trace, which is not what a user asked for.
 */
export function silenceBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPIPE") process.exit(0);
      throw e;
    });
  }
}

export function out(line = ""): void {
  try {
    process.stdout.write(line + "\n");
  } catch {
    /* closed pipe */
  }
}

export function err(line: string): void {
  try {
    process.stderr.write(line + "\n");
  } catch {
    /* closed pipe */
  }
}

export class CtxError extends Error {}

/** Fail with a message the user can act on, not a stack trace. */
export function fail(message: string): never {
  throw new CtxError(message);
}

/** Pad to width, ignoring ANSI so colored columns still line up. */
export function pad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
  return s + " ".repeat(Math.max(0, width - visible));
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${question} [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    const onData = (buf: Buffer) => {
      process.stdin.pause();
      process.stdin.off("data", onData);
      resolve(buf.toString());
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
  return /^\s*y(es)?\s*$/i.test(answer);
}

/**
 * A status line that rewrites itself in place, for work that takes long enough
 * to look hung. Only on a terminal: piped or redirected output stays clean, so
 * --json and scripts are unaffected.
 */
export function progress(label: string): { update(detail?: string): void; done(final?: string): void } {
  const live = process.stdout.isTTY === true;
  const started = Date.now();
  let width = 0;
  let last = 0;

  const paint = (text: string) => {
    try {
      process.stdout.write("\r" + text + " ".repeat(Math.max(0, width - text.length)));
      width = text.length;
    } catch {
      /* closed pipe */
    }
  };

  return {
    update(detail) {
      if (!live) return;
      // Repainting every file would cost more than the work itself.
      const now = Date.now();
      if (now - last < 80) return;
      last = now;
      const secs = Math.round((now - started) / 1000);
      paint(`  ${label}${detail === undefined ? "" : ` ${detail}`}${secs >= 2 ? dim(` ${secs}s`) : ""}`);
    },
    done(final) {
      if (live && width > 0) paint("");
      if (live) {
        try {
          process.stdout.write("\r");
        } catch {
          /* closed pipe */
        }
      }
      if (final !== undefined) out(final);
    },
  };
}

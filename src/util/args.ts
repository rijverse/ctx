export interface Parsed {
  command: string | undefined;
  positionals: string[];
  flags: Map<string, string | true>;
  /** Everything after a bare `--`, handed to the launched process untouched. */
  passthrough: string[];
}

const TAKES_VALUE = new Set(["config", "store", "profile", "from", "only", "add", "as"]);

export function parseArgs(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const passthrough: string[] = [];
  let rest = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (rest) {
      passthrough.push(arg);
      continue;
    }
    if (arg === "--") {
      rest = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (TAKES_VALUE.has(body) && i + 1 < argv.length) {
        flags.set(body, argv[++i]!);
      } else {
        flags.set(body, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (const ch of arg.slice(1)) flags.set(ch, true);
      continue;
    }
    positionals.push(arg);
  }

  return { command: positionals.shift(), positionals, flags, passthrough };
}

export function flagString(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function flagList(p: Parsed, name: string): string[] | undefined {
  const v = flagString(p, name);
  if (v === undefined) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

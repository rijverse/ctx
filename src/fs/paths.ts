import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Expand a leading `~` (or `~/...`) to the home directory (overridable for tests). */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** Expand `~` then resolve to an absolute path. */
export function absPath(p: string, home: string = homedir()): string {
  return resolve(expandHome(p, home));
}

/**
 * Claude Code stores projects under <root>/projects/<encodedCwd>/ where the
 * encoded cwd is the absolute path with each `/` replaced by `-`.
 * Example: /home/robert/www/ctx -> -home-robert-www-ctx
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function decodeCwd(encoded: string): string {
  if (!encoded.startsWith("-")) return encoded;
  return "/" + encoded.slice(1).replace(/-/g, "/");
}

/** Compare two paths after normalization (does not touch the filesystem). */
export function samePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

/** Is `child` equal to or nested inside `parent`? */
export function isInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function normalize(p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(p);
  // Drop a trailing separator so /a/b and /a/b/ compare equal.
  return abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs;
}

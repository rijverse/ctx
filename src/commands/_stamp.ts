/** A filesystem-safe timestamp for backup batch directories. */
export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

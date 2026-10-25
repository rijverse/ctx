import { join } from "node:path";
import type { Profile } from "../types.js";
import { readJson } from "../util/fsx.js";

/**
 * The endpoint behind Claude's own /usage. It is not a published API, so the
 * reply is read loosely: anything unexpected costs a row, never the command.
 */
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 10_000;

export interface Limit {
  /** "session", "week", or the model a narrower weekly cap applies to. */
  label: string;
  /** Percent used, as Anthropic reports it. */
  used: number;
  resetsAt?: string;
}

export type Usage =
  | { state: "ok"; limits: Limit[] }
  /** No Claude login here: logged out, never logged in, or an API key profile. */
  | { state: "none" }
  | { state: "expired" }
  /** macOS keeps the login in the keychain unless it could not. */
  | { state: "keychain" }
  | { state: "error"; message: string };

export interface AccountUsage {
  profile: Profile;
  account?: string;
  plan?: string;
  usage: Usage;
}

interface Login {
  accessToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

interface Window {
  utilization?: number | null;
  resets_at?: string | null;
}

interface Reply {
  limits?: {
    kind?: string;
    percent?: number | null;
    resets_at?: string | null;
    scope?: { model?: { display_name?: string | null } | null } | null;
  }[];
  five_hour?: Window | null;
  seven_day?: Window | null;
  seven_day_opus?: Window | null;
  seven_day_sonnet?: Window | null;
}

export async function usageOf(profile: Profile, now = Date.now()): Promise<AccountUsage> {
  let account: string | undefined;
  try {
    const registry = await readJson<{ oauthAccount?: { emailAddress?: string } }>(profile.registryPath);
    account = registry?.oauthAccount?.emailAddress;
  } catch {
    /* only a label */
  }

  const path = join(profile.dir, ".credentials.json");
  let file: { claudeAiOauth?: Login } | undefined;
  try {
    file = await readJson(path);
  } catch {
    return { profile, account, usage: { state: "error", message: "its .credentials.json is not valid JSON" } };
  }
  if (file === undefined && process.platform === "darwin") return { profile, account, usage: { state: "keychain" } };

  const login = file?.claudeAiOauth;
  const base = { profile, account, plan: login?.subscriptionType };
  if (typeof login?.accessToken !== "string" || login.accessToken === "") return { ...base, usage: { state: "none" } };
  // Renewing would mean spending the refresh token, which rotates. A claude
  // running in this profile still holds the old one and would be logged out,
  // so an expired login is only reported. Claude renews it on its next start.
  if (typeof login.expiresAt === "number" && login.expiresAt <= now) return { ...base, usage: { state: "expired" } };

  return { ...base, usage: await ask(login.accessToken) };
}

async function ask(token: string): Promise<Usage> {
  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if ((e as Error).name === "TimeoutError") return { state: "error", message: `no answer in ${TIMEOUT_MS / 1000}s` };
    const code = ((e as Error).cause as NodeJS.ErrnoException | undefined)?.code;
    return { state: "error", message: `could not reach Anthropic${code === undefined ? "" : ` (${code})`}` };
  }
  // Revoked, by a logout on another machine for instance.
  if (res.status === 401) return { state: "expired" };
  if (!res.ok) return { state: "error", message: `Anthropic answered ${res.status}` };
  try {
    return { state: "ok", limits: limitsFrom((await res.json()) as Reply) };
  } catch {
    return { state: "error", message: "Anthropic's answer was not JSON" };
  }
}

const KINDS: Record<string, string> = { session: "session", weekly_all: "week" };

/**
 * `limits` is the list /usage draws from. A reply without it falls back to the
 * older per-window keys, which carry the same numbers for the main limits.
 */
export function limitsFrom(reply: Reply): Limit[] {
  if (Array.isArray(reply.limits)) {
    return reply.limits.flatMap((l) => {
      if (typeof l.percent !== "number") return [];
      const label = KINDS[l.kind ?? ""] ?? l.scope?.model?.display_name ?? l.kind ?? "other";
      return [limit(label, l.percent, l.resets_at)];
    });
  }
  const windows: [string, Window | null | undefined][] = [
    ["session", reply.five_hour],
    ["week", reply.seven_day],
    ["Opus", reply.seven_day_opus],
    ["Sonnet", reply.seven_day_sonnet],
  ];
  return windows.flatMap(([label, w]) =>
    typeof w?.utilization === "number" ? [limit(label, w.utilization, w.resets_at)] : [],
  );
}

function limit(label: string, used: number, resetsAt: string | null | undefined): Limit {
  return resetsAt ? { label, used, resetsAt } : { label, used };
}

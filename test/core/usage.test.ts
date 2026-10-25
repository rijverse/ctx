import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileFromDir } from "../../src/core/paths.js";
import { limitsFrom, usageOf } from "../../src/core/usage.js";
import { fakeHome, type FakeHome } from "../helpers/fakeHome.js";

let fh: FakeHome;
beforeEach(async () => {
  fh = await fakeHome();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fh.dispose();
});

const NOW = Date.parse("2026-10-25T08:00:00Z");
const HOUR = 3_600_000;

async function account(name: string, login: object | undefined): Promise<ReturnType<typeof profileFromDir>> {
  const layout = login === undefined ? {} : { ".credentials.json": JSON.stringify(login) };
  const dir = await fh.profile(name, layout);
  await fh.registry(name, { oauthAccount: { emailAddress: `${name}@x.test` } });
  return profileFromDir(dir);
}

const live = (token = "tok") => ({
  claudeAiOauth: { accessToken: token, expiresAt: NOW + HOUR, subscriptionType: "max" },
});

function answer(status: number, body: unknown) {
  const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("limitsFrom", () => {
  it("reads the limits list /usage draws, naming a scoped cap after its model", () => {
    expect(
      limitsFrom({
        limits: [
          { kind: "session", percent: 79, resets_at: "2026-10-25T09:00:00+00:00" },
          { kind: "weekly_all", percent: 17, resets_at: "2026-10-29T20:00:00+00:00" },
          { kind: "weekly_scoped", percent: 0, resets_at: null, scope: { model: { display_name: "Fable" } } },
        ],
      }),
    ).toEqual([
      { label: "session", used: 79, resetsAt: "2026-10-25T09:00:00+00:00" },
      { label: "week", used: 17, resetsAt: "2026-10-29T20:00:00+00:00" },
      { label: "Fable", used: 0 },
    ]);
  });

  it("falls back to the per-window keys when there is no list", () => {
    expect(
      limitsFrom({
        five_hour: { utilization: 40, resets_at: "2026-10-25T09:00:00+00:00" },
        seven_day: { utilization: 5, resets_at: null },
        seven_day_opus: null,
      }),
    ).toEqual([
      { label: "session", used: 40, resetsAt: "2026-10-25T09:00:00+00:00" },
      { label: "week", used: 5 },
    ]);
  });

  it("skips entries without a number rather than inventing one", () => {
    expect(limitsFrom({ limits: [{ kind: "session" }, { kind: "weekly_all", percent: 3 }] })).toEqual([
      { label: "week", used: 3 },
    ]);
  });
});

describe("usageOf", () => {
  it("asks with the profile's own token and reports its limits", async () => {
    const fetch = answer(200, { limits: [{ kind: "session", percent: 12, resets_at: null }] });
    const got = await usageOf(await account("me", live("me-token")), NOW);

    expect(got.account).toBe("me@x.test");
    expect(got.plan).toBe("max");
    expect(got.usage).toEqual({ state: "ok", limits: [{ label: "session", used: 12 }] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer me-token");
  });

  it("says not logged in without asking when there is no login", async () => {
    const fetch = answer(200, {});
    expect((await usageOf(await account("none", undefined), NOW)).usage.state).toBe("none");
    expect((await usageOf(await account("guest", { mcpOAuth: {} }), NOW)).usage.state).toBe("none");
    const out = await usageOf(await account("out", { claudeAiOauth: { accessToken: "", expiresAt: 0 } }), NOW);
    expect(out.usage.state).toBe("none");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an expired login instead of renewing it", async () => {
    const fetch = answer(200, {});
    const login = { claudeAiOauth: { accessToken: "old", refreshToken: "r", expiresAt: NOW - HOUR } };
    const profile = await account("stale", login);

    expect((await usageOf(profile, NOW)).usage.state).toBe("expired");
    expect(fetch).not.toHaveBeenCalled();
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(`${profile.dir}/.credentials.json`, "utf8"))).toEqual(login);
  });

  it("treats a rejected token as expired and other failures as errors", async () => {
    answer(401, { error: "nope" });
    expect((await usageOf(await account("revoked", live()), NOW)).usage.state).toBe("expired");

    answer(503, {});
    expect((await usageOf(await account("down", live()), NOW)).usage).toEqual({
      state: "error",
      message: "Anthropic answered 503",
    });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const offline = await usageOf(await account("offline", live()), NOW);
    expect(offline.usage.state).toBe("error");
  });

  it("does not let an unreadable login file stop the others", async () => {
    const dir = await fh.profile("broken", { ".credentials.json": "{not json" });
    expect((await usageOf(profileFromDir(dir), NOW)).usage.state).toBe("error");
  });
});

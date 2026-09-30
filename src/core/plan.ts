import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { EntryState, Plan, Profile, Step, StepKind } from "../types.js";
import { exists, samePath } from "../util/fsx.js";
import type { Config } from "./config.js";
import { isGuarded, itemByName } from "./inventory.js";

export async function stateOf(path: string, storeSlot: string): Promise<EntryState> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink()) {
    if (!(await exists(await resolved(path)))) return "dangling";
    return (await samePath(path, storeSlot)) ? "linked" : "misdirected";
  }
  return st.isDirectory() ? "dir" : "file";
}

async function resolved(path: string): Promise<string> {
  const { readlink } = await import("node:fs/promises");
  const target = await readlink(path);
  return target.startsWith("/") ? target : join(path, "..", target);
}

/**
 * What `ctx sync` would do to bring one profile in line with the store.
 *
 * `pending` lets a caller plan several profiles in one pass: once the first
 * profile seeds `projects`, the second one absorbs into it rather than trying
 * to seed it a second time.
 */
export async function planSync(
  profile: Profile,
  store: string,
  config: Config,
  only?: string[],
  pending?: Set<string>,
): Promise<Plan> {
  const names = only ?? config.shared;
  const steps: Step[] = [];

  for (const name of names) {
    const item = itemByName(name);
    if (item === undefined || isGuarded(name) || item.role !== "shared") continue;

    const from = join(profile.dir, name);
    const to = join(store, name);
    const state = await stateOf(from, to);
    const storeHas = (await exists(to)) || pending?.has(name) === true;
    if (state !== "absent") pending?.add(name);

    steps.push({
      profile: profile.name,
      item,
      from,
      to,
      state,
      storeHas,
      ...classify(state, storeHas),
    });
  }

  return { steps, effective: steps.filter((s) => s.kind !== "keep") };
}

function classify(
  state: EntryState,
  storeHas: boolean,
): { kind: StepKind; detail?: string } {
  switch (state) {
    case "linked":
      return { kind: "keep" };
    case "misdirected":
      return { kind: "relink", detail: "points outside the store" };
    case "dangling":
      return { kind: "relink", detail: "target is gone" };
    case "absent":
      return storeHas ? { kind: "attach" } : { kind: "keep", detail: "nothing on either side" };
    case "dir":
      return storeHas
        ? { kind: "absorb", detail: "merge into the store, store copy wins on collisions" }
        : { kind: "seed", detail: "becomes the store's copy" };
    case "file":
      return storeHas
        ? { kind: "stash", detail: "store copy wins, yours is backed up" }
        : { kind: "seed", detail: "becomes the store's copy" };
  }
}

/** What `ctx detach` would do: turn links back into independent real copies. */
export async function planDetach(
  profile: Profile,
  store: string,
  config: Config,
  only?: string[],
): Promise<Plan> {
  const names = only ?? config.shared;
  const steps: Step[] = [];

  for (const name of names) {
    const item = itemByName(name);
    if (item === undefined || isGuarded(name)) continue;

    const from = join(profile.dir, name);
    const to = join(store, name);
    const state = await stateOf(from, to);
    const storeHas = await exists(to);
    const detachable = state === "linked" || state === "misdirected" || state === "dangling";

    steps.push({
      profile: profile.name,
      item,
      from,
      to,
      state,
      storeHas,
      kind: detachable && storeHas ? "detach" : "keep",
      detail: detachable && !storeHas ? "store has no copy to hand back" : undefined,
    });
  }

  return { steps, effective: steps.filter((s) => s.kind !== "keep") };
}

/** What `ctx doctor` would fix: only links that are broken or point elsewhere. */
export async function planRepair(
  profile: Profile,
  store: string,
  config: Config,
): Promise<Plan> {
  const full = await planSync(profile, store, config);
  const steps = full.steps.map((s) =>
    s.kind === "relink" ? s : ({ ...s, kind: "keep", detail: undefined } satisfies Step),
  );
  return { steps, effective: steps.filter((s) => s.kind !== "keep") };
}

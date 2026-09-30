import { requireConfig, type Config } from "../core/config.js";
import { flagList, flagString, type Parsed } from "../util/args.js";
import { storePath } from "../core/paths.js";

export interface Ctx {
  store: string;
  config: Config;
  args: Parsed;
  yes: boolean;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  only: string[] | undefined;
}

export function globals(args: Parsed): Omit<Ctx, "config"> {
  return {
    store: storePath(flagString(args, "store")),
    args,
    yes: args.flags.has("yes") || args.flags.has("y"),
    dryRun: args.flags.has("dry-run") || args.flags.has("n"),
    json: args.flags.has("json"),
    verbose: args.flags.has("verbose") || args.flags.has("v"),
    only: flagList(args, "only"),
  };
}

export async function context(args: Parsed): Promise<Ctx> {
  const base = globals(args);
  return { ...base, config: await requireConfig(base.store) };
}

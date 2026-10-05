#!/usr/bin/env bash
# Move this machine's Claude profiles onto a ctx store, one checked step at a
# time: back up, create the store, seed it, try one more profile, then the rest.
#
#   ./rollout.sh [--add DIR,DIR] [--seed PROFILE] [trial-profile]
#
#   --add    profile dirs outside ~/.claude and ~/.claude-*, wherever
#            CLAUDE_CONFIG_DIR points for them
#   --seed   the profile the store starts from. Defaults to ~/.claude, and is
#            asked for when there is none.
#   trial    one more profile to try before the rest. Defaults to "guest".
#
# The seed always goes first. The first profile synced becomes the store's copy,
# and on a name collision the store wins, so the seed decides whose
# settings.json, CLAUDE.md and plugins everyone ends up with.
#
# Nothing changes without a yes at a prompt. Run it from a plain terminal with
# every claude session closed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
store="${CTX_STORE:-$HOME/.ctx-store}"
add=""
seed=""
trial="guest"
while (($# > 0)); do
  case $1 in
    --add) add="${2:?--add needs a directory}"; shift 2 ;;
    --seed) seed="${2:?--seed needs a profile name}"; shift 2 ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) printf 'unknown option %s\n' "$1" >&2; exit 2 ;;
    *) trial="$1"; shift ;;
  esac
done

ctx() { node "$here/dist/cli.js" "$@"; }
say() { printf '\n== %s\n' "$*"; }
short() { printf '%s' "${1/#"$HOME"/'~'}"; }
ask() {
  local a
  read -r -p "$* [y/N] " a || true
  [[ $a =~ ^[Yy]([Ee][Ss])?$ ]]
}
stop() {
  printf '%s\n' "$*" >&2
  exit 1
}

# Every profile ctx would manage, with --add folded in, one per line as
# "P<TAB>name<TAB>dir<TAB>pids of live claude sessions", then the Claude dirs it
# is not managing as "C<TAB>name<TAB>dir<TAB>how it was found". Uses ctx's own
# code, so it sees exactly what ctx will see.
profiles() {
  node --input-type=module -e '
    process.on("uncaughtException", (e) => {
      console.error(e?.constructor?.name === "CtxError" ? `ctx: ${e.message}` : e);
      process.exit(1);
    });
    const [dir, extra] = process.argv.slice(1);
    const { defaultConfig, loadConfig } = await import(`${dir}/dist/core/config.js`);
    const { expand, storePath } = await import(`${dir}/dist/core/paths.js`);
    const { candidates, listProfiles } = await import(`${dir}/dist/core/profiles.js`);
    const { liveSessions } = await import(`${dir}/dist/core/live.js`);
    const store = storePath();
    const config = (await loadConfig(store)) ?? defaultConfig();
    for (const d of extra ? extra.split(",") : []) config.profiles.push(expand(d.trim()));
    const managed = await listProfiles(config, store);
    for (const p of managed) {
      console.log(["P", p.name, p.dir, (await liveSessions(p)).join(" ")].join("\t"));
    }
    for (const c of await candidates(managed, store)) console.log(["C", c.name, c.dir, c.why].join("\t"));
  ' "$here" "$add"
}

# Steps a sync of one profile would take, empty when there is no such profile.
pending() {
  ctx sync "$1" --json 2>/dev/null |
    node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).plans[0].steps.length)' || true
}

say "Preflight"
[[ -z ${CLAUDECODE:-} ]] || stop "This shell was started by claude. Run the script from a plain terminal."
command -v node >/dev/null || stop "node is not on PATH."
major="$(node -p 'process.versions.node.split(".")[0]')"
((major >= 20)) || stop "ctx needs Node 20 or newer, this is $(node --version)."
if [[ ! -f $here/dist/cli.js ]]; then
  echo "building ctx"
  (cd "$here" && npm run build >/dev/null)
fi

list="$(profiles)" || stop "Stopped before changing anything."

# A Claude dir under another name, ~/.my-claude say, is offered, not taken: a
# backup copy of a profile looks the same and should stay out of the store.
found_names=()
found_dirs=()
found_why=()
while IFS=$'\t' read -r kind name dir why; do
  [[ $kind == C ]] || continue
  found_names+=("$name")
  found_dirs+=("$dir")
  found_why+=("$why")
done <<<"$list"
if ((${#found_names[@]} > 0)); then
  echo "Found Claude dirs ctx is not managing yet:"
  for i in "${!found_names[@]}"; do
    printf '  %-14s %s  (%s)\n' "${found_names[$i]}" "$(short "${found_dirs[$i]}")" "${found_why[$i]}"
    if ask "  Manage it as \"${found_names[$i]}\"?"; then add="${add:+$add,}${found_dirs[$i]}"; fi
  done
  list="$(profiles)" || stop "Stopped before changing anything."
fi

names=()
dirs=()
running=""
while IFS=$'\t' read -r kind name dir pids; do
  [[ $kind == P ]] || continue
  names+=("$name")
  dirs+=("$dir")
  [[ -z $pids ]] || running+="  $name (pid ${pids// /, })"$'\n'
done <<<"$list"
((${#names[@]} > 0)) || stop "No Claude profiles found. Point at yours with --add DIR,DIR."
for i in "${!names[@]}"; do printf '  %-14s %s\n' "${names[$i]}" "$(short "${dirs[$i]}")"; done
if [[ -n $running ]]; then
  printf 'claude is still running in:\n%s' "$running"
  stop "Exit those sessions and run this again."
fi
echo "ok, no claude sessions running"

has() {
  local n
  for n in "${names[@]}"; do [[ $n == "$1" ]] && return 0; done
  return 1
}

say "Backup"
items=("${dirs[@]}")
[[ -f $HOME/.claude.json ]] && items+=("$HOME/.claude.json")
backup="$HOME/claude-backup-$(date +%Y%m%d-%H%M%S).tgz"
for item in "${items[@]}"; do printf '  %s\n' "$(short "$item")"; done
echo "goes to $(short "$backup")"
echo "It holds your login tokens, so it is written 0600. Keep it private."
ask "Write the backup?" || stop "Stopped. Nothing was changed."
# Absolute paths, so each profile restores to where it was, wherever it lives.
(umask 077 && tar czPf "$backup" "${items[@]}")
tar tzPf "$backup" >/dev/null || stop "The backup does not read back. Stopping before anything else."
echo "ok, $(du -h "$backup" | cut -f1)"

say "Store"
if [[ -f $store/ctx.json ]]; then
  echo "already set up at $(short "$store")"
  if [[ -n $add ]]; then
    IFS=, read -r -a extra <<<"$add"
    ctx add "${extra[@]}"
  fi
  seed="$(node -p 'require(process.argv[1]).seed ?? ""' "$store/ctx.json")"
  [[ -n $seed ]] || seed=default
else
  if [[ -z $seed ]]; then
    if has default; then
      seed=default
    elif ((${#names[@]} == 1)); then
      seed="${names[0]}"
    else
      echo "There is no ~/.claude, so the store needs another profile to start from."
      echo "Its settings.json, CLAUDE.md and plugins become everyone's."
      read -r -p "Seed profile (${names[*]}): " seed || true
    fi
  fi
  has "$seed" || stop "No profile named \"$seed\". Found: ${names[*]}"
  init=(--from "$seed")
  [[ -z $add ]] || init+=(--add "$add")
  ctx init --dry-run "${init[@]}"
  ask "Create the store?" || stop "Stopped. Only the backup was written."
  ctx init -y "${init[@]}"
fi

say "Seed the store from $seed"
echo "Its settings.json, CLAUDE.md, skills, plugins and history become the shared"
echo "copies. A profile synced later keeps its own colliding files in the backup."
n="$(pending "$seed")"
if [[ -z $n ]]; then
  stop "The seed profile \"$seed\" is gone. Set \"seed\" in $(short "$store/ctx.json") to one that exists."
elif ((n == 0)); then
  echo "$seed is already linked"
else
  ctx sync "$seed" --dry-run
  ask "Sync $seed now?" || stop "Stopped. Only the backup and the empty store were written."
  ctx sync "$seed" -y
  ctx registry pull "$seed"
fi

say "Trial run on $trial"
n="$(pending "$trial")"
if [[ $trial == "$seed" ]]; then
  echo "$trial is the seed, so there is nothing more to try"
elif [[ -z $n ]]; then
  echo "no profile named $trial, skipping the trial"
elif ((n == 0)); then
  echo "$trial is already linked"
else
  ctx sync "$trial" --dry-run
  if ask "Sync $trial now?"; then
    ctx sync "$trial" -y
    ctx registry pull "$trial"
    ctx status
    echo
    echo "Try it from another terminal before going on:"
    echo "  node $here/dist/cli.js run $trial"
    ask "Did $trial work? Go on with every profile?" ||
      stop "Stopped after $trial. \`node $here/dist/cli.js detach $trial\` undoes it."
  fi
fi

say "Every profile"
ctx sync --all --dry-run
ask "Sync every profile?" || stop "Stopped. Profiles already synced stay that way. \`ctx detach <profile>\` undoes one."
ctx sync --all -y

say "Registry"
echo "Write the shared trust decisions and MCP servers into every profile now,"
echo "so plain \`claude\` sees them too, not only \`ctx run\`. Logins are not touched."
if ask "Pull the registry into every profile?"; then
  for name in "${names[@]}"; do ctx registry pull "$name"; done
fi

say "Check"
ctx doctor || echo "doctor found something, see above"
ctx status

say "SessionEnd hook (optional)"
echo "Only needed if you start claude without \`ctx run\`. It folds those"
echo "sessions' .claude.json changes into the store when they end."
if ask "Install it?"; then
  ctx hooks install -y
  # The hook lives in the store's settings.json, so every profile has to link it.
  ctx sync --all -y --only settings.json
fi

say "Done"
echo "backup:  $(short "$backup")"
echo "launch:  node $here/dist/cli.js run <profile>    (or \`ctx run\` after npm link)"
echo "undo:    node $here/dist/cli.js detach <profile>"

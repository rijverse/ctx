#!/usr/bin/env bash
# Move this machine's Claude profiles onto a ctx store: back up, create the
# store, fold every profile into it, share the registry, install the hook.
#
#   ./rollout.sh [--add DIR,DIR] [--seed PROFILE] [-n] [-y]
#
#   --add    profile dirs outside ~/.claude and ~/.claude-*, wherever
#            CLAUDE_CONFIG_DIR points for them
#   --seed   the profile the store starts from. Defaults to ~/.claude, and is
#            asked for when there is none.
#   -n       print the plan and stop
#   -y       do not ask at all
#
# It shows the whole plan, asks once, then runs to the end. The seed goes
# first: the first profile synced becomes the store's copy, and on a name
# collision the store wins, so the seed decides whose settings.json, CLAUDE.md
# and plugins everyone ends up with.
#
# Claude running in any of the profiles is stopped before the backup, except
# the session this script runs under.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
store="${CTX_STORE:-$HOME/.ctx-store}"
add=""
seed=""
dry=0
yes=0
while (($# > 0)); do
  case $1 in
    --add) add="${2:?--add needs a directory}"; shift 2 ;;
    --seed) seed="${2:?--seed needs a profile name}"; shift 2 ;;
    -n | --dry-run) dry=1; shift ;;
    -y | --yes) yes=1; shift ;;
    -h | --help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

ctx() { node "$here/dist/cli.js" "$@"; }
say() { printf '\n%s\n' "$*"; }
short() { printf '%s' "${1/#"$HOME"/'~'}"; }
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

# Stop claude in every managed profile, the way ctx sync does: graceful first,
# never the session this script itself runs under, and say what was stopped.
stop_sessions() {
  node --input-type=module -e '
    const [dir, extra] = process.argv.slice(1);
    const { defaultConfig, loadConfig } = await import(`${dir}/dist/core/config.js`);
    const { expand, storePath, tilde } = await import(`${dir}/dist/core/paths.js`);
    const { listProfiles } = await import(`${dir}/dist/core/profiles.js`);
    const { findRunning, stopRunning } = await import(`${dir}/dist/core/live.js`);
    const store = storePath();
    const config = (await loadConfig(store)) ?? defaultConfig();
    for (const d of extra ? extra.split(",") : []) config.profiles.push(expand(d.trim()));
    const running = await findRunning(await listProfiles(config, store));
    const label = (rs) => rs.map((r) => `${r.profile.name} (pid ${r.pid}${r.cwd ? `, ${tilde(r.cwd)}` : ""})`).join(", ");
    for (const r of running.filter((r) => r.self)) {
      console.log(`warning: claude in ${r.profile.name} (pid ${r.pid}) runs this script, so it keeps running. Restart it once this finishes.`);
    }
    const others = running.filter((r) => !r.self);
    if (others.length > 0) {
      console.log(`warning: stopping claude in ${label(others)}.`);
      const left = await stopRunning(others);
      console.log("  Their transcripts are saved. `claude --continue` in that folder picks a session up again.");
      if (left.length > 0) console.log(`warning: ${label(left)} would not stop. Carrying on anyway.`);
    }
  ' "$here" "$add"
}

# tar says nothing for minutes on a big home, so poll what it has written
# against what the sources add up to.
backup_with_progress() {
  local out=$1
  shift
  local total
  total="$(du -sbc "$@" 2>/dev/null | tail -1 | cut -f1)"
  (umask 077 && tar czPf "$out" "$@") &
  local pid=$!
  if [[ -t 1 ]]; then
    while kill -0 $pid 2>/dev/null; do
      local now
      now="$(stat -c %s "$out" 2>/dev/null || echo 0)"
      printf '\r  writing %s of about %s (compressed)   ' "$(numfmt --to=iec "$now" 2>/dev/null || echo "$now")" \
        "$(numfmt --to=iec "$total" 2>/dev/null || echo "$total")"
      sleep 1
    done
    printf '\r%*s\r' 60 ''
  fi
  wait $pid
}

[[ -z ${CLAUDECODE:-} ]] || echo "warning: this shell was started by claude. That session keeps running, so restart it once this finishes."
command -v node >/dev/null || stop "node is not on PATH."
major="$(node -p 'process.versions.node.split(".")[0]')"
((major >= 20)) || stop "ctx needs Node 20 or newer, this is $(node --version)."
if [[ ! -f $here/dist/cli.js ]]; then
  echo "building ctx"
  (cd "$here" && npm run build >/dev/null)
fi

list="$(profiles)" || stop "Stopped before changing anything."
names=()
dirs=()
running=0
found=""
while IFS=$'\t' read -r kind name dir rest; do
  case $kind in
    P)
      names+=("$name")
      dirs+=("$dir")
      [[ -z $rest ]] || running=$((running + 1))
      ;;
    C) found+="  $name  $(short "$dir")  ($rest)"$'\n' ;;
  esac
done <<<"$list"
((${#names[@]} > 0)) || stop "No Claude profiles found, so there is nothing to move over.
Starting fresh needs no script: \`ctx init\`, then \`ctx run default\` and \`ctx run <name>\` once per account.
If yours live somewhere unusual, point at them with --add DIR,DIR."

has() {
  local n
  for n in "${names[@]}"; do [[ $n == "$1" ]] && return 0; done
  return 1
}

fresh=0
if [[ -f $store/ctx.json ]]; then
  seed="$(node -p 'require(process.argv[1]).seed ?? ""' "$store/ctx.json")"
  [[ -n $seed ]] || seed=default
else
  fresh=1
  if [[ -z $seed ]]; then
    if has default; then
      seed=default
    elif ((${#names[@]} == 1)); then
      seed="${names[0]}"
    elif ((yes == 1 || dry == 1)); then
      stop "There is no ~/.claude, so name the profile the store starts from: --seed <${names[0]}|...>"
    else
      echo "There is no ~/.claude, so the store needs another profile to start from."
      echo "Its settings.json, CLAUDE.md and plugins become everyone's."
      read -r -p "Seed profile (${names[*]}): " seed || true
    fi
  fi
  has "$seed" || stop "No profile named \"$seed\". Found: ${names[*]}"
fi

items=("${dirs[@]}")
[[ -f $HOME/.claude.json ]] && items+=("$HOME/.claude.json")
backup="$HOME/claude-backup-$(date +%Y%m%d-%H%M%S).tgz"

say "This will set up one shared store for $(short "$store")"
printf '\n  %-14s %s\n' "profile" "directory"
for i in "${!names[@]}"; do
  printf '  %-14s %s%s\n' "${names[$i]}" "$(short "${dirs[$i]}")" \
    "$([[ ${names[$i]} == "$seed" ]] && printf '   seeds the store' || true)"
done
[[ -z $found ]] || printf '\nClaude dirs ctx is not managing (pass --add to include one):\n%s' "$found"
say "Steps, in order, no further questions:"
cat <<TXT
  1  back up every profile to $(short "$backup")
  2  $( ((fresh)) && echo "create the store, seeded from $seed" || echo "use the store that is already at $(short "$store")")
  3  fold all ${#names[@]} profile(s) into it and link them, $seed first
  4  share the project trust and MCP servers into every profile
  5  install the SessionEnd hook, so sessions you start by hand fold back too
TXT
((running == 0)) || echo "
  claude is running in $running profile(s) and will be stopped first, except this one"
echo

if ((dry)); then
  echo "--dry-run: nothing was changed."
  exit 0
fi
if ((yes == 0)); then
  read -r -p "Go ahead? [y/N] " a || true
  [[ ${a:-} =~ ^[Yy]([Ee][Ss])?$ ]] || stop "Nothing was changed."
fi

((running == 0)) || stop_sessions

say "1/5  Backup"
backup_with_progress "$backup" "${items[@]}"
tar tzPf "$backup" >/dev/null || stop "The backup does not read back. Stopping before anything else."
echo "  $(short "$backup")  $(du -h "$backup" | cut -f1)"

say "2/5  Store"
if ((fresh)); then
  init=(--from "$seed")
  [[ -z $add ]] || init+=(--add "$add")
  ctx init -y "${init[@]}" >/dev/null
  echo "  created $(short "$store"), seeded from $seed"
else
  [[ -z $add ]] || ctx add "${add//,/ }"
  echo "  using $(short "$store"), seeded from $seed"
fi

say "3/5  Folding every profile in"
ctx sync --all -y

say "4/5  Sharing the registry"
for name in "${names[@]}"; do ctx registry pull "$name" | sed 's/^/  /'; done

say "5/5  SessionEnd hook"
ctx hooks install -y | sed 's/^/  /'
ctx sync --all -y --only settings.json >/dev/null

say "Check"
ctx doctor || echo "doctor found something, see above"

say "Done"
echo "  backup:  $(short "$backup")"
echo "  launch:  node $here/dist/cli.js run <profile>    (or \`ctx run\` after npm link)"
echo "  undo:    node $here/dist/cli.js detach --all"

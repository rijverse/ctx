# ctx

[![ci](https://github.com/rijverse/ctx/actions/workflows/ci.yml/badge.svg)](https://github.com/rijverse/ctx/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

One source of truth for every Claude Code account on a machine: shared
sessions, skills, settings and trusted projects, separate logins.

Claude Code keeps everything in one directory, `~/.claude` by default, and
`CLAUDE_CONFIG_DIR` moves that directory somewhere else. So running a second
account looks like this:

```sh
CLAUDE_CONFIG_DIR=~/.claude-work claude
```

which gives you a second, completely separate world: different session history,
different skills, different settings, different everything. That is right for
the login and wrong for the work. `ctx` keeps the logins apart and puts the work
in one place.

## How it works

One store holds the only real copy of everything shareable. Each profile
directory keeps its identity files and gets a symlink for the rest.

```
~/.ctx-store/                 the only real copy
  projects/  skills/  agents/  commands/  rules/  plans/
  todos/  file-history/  plugins/
  settings.json  CLAUDE.md  history.jsonl
  registry.json               the shared half of .claude.json
  ctx.json                    what is shared, the seed, extra profile dirs
  .bases/                     merge history for .claude.json, per profile
  .backups/                   anything ctx displaced, per profile and run

~/.claude/                    derived
  .credentials.json           real, yours alone
  projects      -> ~/.ctx-store/projects
  skills        -> ~/.ctx-store/skills
  settings.json -> ~/.ctx-store/settings.json

~/.claude-me/                 same shape, different login
  .credentials.json           real, someone else's
  projects      -> ~/.ctx-store/projects
  ...
```

Plain `claude` keeps working with no shell changes, because `~/.claude` is just
another profile pointing at the store. Start a session under one account, resume
it under another: it is the same directory on disk.

## Install

Node 20 or newer, on Linux or macOS.

```sh
npm install -g @rijverse/ctx
```

Or from a checkout:

```sh
npm install
npm run build
npm link          # optional, puts `ctx` on your PATH
```

and run it in place with `node dist/cli.js <command>` if you skip the link.

## Quick start

Close every running `claude` session first. `sync` refuses a profile while
one is open in it.

```sh
ctx init            # create the store, with ~/.claude as its seed
ctx sync --all      # fold every profile into it, the seed first
ctx status          # see the result
ctx run me          # launch claude as ~/.claude-me, shared data
```

Nothing is written until you confirm. `--dry-run` prints the plan and stops,
`-y` skips the prompt.

To move an existing machine over with a backup first and one trial profile
before the rest, use the script in this repo:

```sh
./rollout.sh [--add DIR,DIR] [--seed PROFILE] [trial-profile]
```

### The seed

The store starts from one profile, the seed, and `sync` always does that one
first. Its `settings.json`, `CLAUDE.md`, skills and plugins become everyone's,
and when another profile has a file of the same name, the store's copy wins and
the other one goes to that profile's backup. The seed is `~/.claude` unless you
say otherwise with `ctx init --from <profile>`, and is recorded in `ctx.json`.
With no `~/.claude` and more than one profile, `init` asks rather than guesses.
A `sync` that would let another profile get in ahead of the seed is refused
until the seed is synced.

### Profiles with other names

`CLAUDE_CONFIG_DIR` can point anywhere. `~/.claude` and `~/.claude-*` are found
on their own. A config dir under any other name, `~/.my-claude` say, is spotted
when `CLAUDE_CONFIG_DIR` points at it in your shell or a shell startup file
(`.zshrc`, `.bashrc`, an alias, fish's `config.fish`), or when a directory in
`~` holds a `.claude.json` or `.credentials.json`. Those are only suggested:
`init` asks about each one, `status` lists them, and `ctx run my-claude` tells
you to add it instead of making a new profile. A backup copy of a profile looks
exactly like a profile, so nothing is taken in without a yes. Adding by path:

```sh
ctx init --add ~/work/.claude,~/accounts/alpha    # before there is a store
ctx add ~/clients/acme/.claude                   # after
ctx add ~/clients/acme/.claude --as acme-client  # pick the name yourself
```

`~/.claude-work` is called `work`, a `.claude` directory is named after its
parent (`~/work/.claude` is `work`), and any other directory goes by its own
name. Two profiles can never share a name, because backups and merge history
are kept by it. When two would, ctx stops and asks for `--as`.

## What is shared, and what is never shared

Shared, moved into the store once and symlinked back:

| | |
|---|---|
| `projects` | session transcripts, the reason this exists |
| `todos`, `file-history`, `session-env`, `tasks`, `paste-cache` | the state that makes a transcript resumable |
| `history.jsonl` | prompt history |
| `skills`, `agents`, `commands`, `output-styles`, `rules`, `plans`, `memory` | things you wrote |
| `plugins` | marketplaces and installed plugins |
| `settings.json`, `CLAUDE.md`, `downloads` | |

Never shared, and `ctx` refuses to move them even if you edit the config to say
otherwise:

`.credentials.json`, `.claude.json`, `policy-limits.json` (and its
`.stamp.json`), `remote-settings.json`, `stats-cache.json`,
`settings.local.json`, `mcp-needs-auth-cache.json`

Left alone entirely, neither shared nor guarded: `cache`, `sessions`,
`shell-snapshots`, `ide`, `telemetry`, `backups`, `chrome`, `daemon`, `jobs`,
`feedback`.

Anything Claude adds that `ctx` has never heard of is left alone. A new release
cannot quietly get something shared.

## The `.claude.json` split

`.claude.json` is the awkward one. It holds who you are logged in as and what
you have been working on, in the same file, so it can be neither symlinked nor
ignored. `ctx` owns an allowlist of top-level keys and leaves the rest of the
file untouched:

| shared, kept in `registry.json` | stays with the profile |
|---|---|
| `projects` (trust decisions, per-project MCP servers, allowed tools) | `oauthAccount`, `userID`, `machineID` |
| `mcpServers` | subscription and entitlement caches |
| `tipsHistory`, `skillUsage`, `pluginUsage`, `githubRepoPaths` | startup counters, migration flags |
| `hasCompletedOnboarding`, `promptQueueUseCount` | everything else, including keys added by future releases |

`ctx run <profile>` folds the profile into the store and writes the shared keys
back in before launching, then folds what the session changed back out
afterwards. Folding is a three-way merge against what that profile and the store
last agreed on, kept in `<store>/.bases/`:

- A change on one side wins over a side that did not touch it, deletions
  included. Remove an MCP server in one account and it is gone from all of them.
- Objects merge entry by entry, so two accounts working on different repos
  never erase each other.
- When both sides changed the same value, lists such as `allowedTools` merge as
  sets, a flag either side set (like a trust decision) stays set, an edit beats
  a deletion, and otherwise the profile wins as the latest writer.
- A profile whose project registry suddenly went empty looks reset, not
  curated. It is restored from the store instead of being merged into it, so
  one wiped `.claude.json` cannot wipe every account.
- A `.claude.json` that does not parse is never read as empty. `ctx` leaves it
  untouched and says so, and `ctx run` still launches `claude` so it can
  recover the file itself.

Writes to `.claude.json` take the same `<file>.lock` Claude takes when it saves
the file, so a pull never lands in the middle of a running session's save.

The practical effect: trust a repo once, and every account trusts it. Add an MCP
server once, and every account has it. Log in once per account, and that login
stays put.

```sh
ctx registry show           # what the store holds
ctx registry diff me        # store against one profile
ctx registry pull me        # store -> profile
ctx registry push me        # profile -> store
```

If you start `claude` some other way, `ctx hooks install` adds a `SessionEnd`
hook to the shared `settings.json` so the session still folds its changes back
into the store on exit. A non-default `--store` is written into the hook, and
installing again after moving `ctx` updates the path in place.

Only the push half is hookable. `SessionStart` fires after Claude has already
read `.claude.json`, so pulling there would be overwritten by Claude's own next
save. Pulling stays the job of `ctx run`.

## Commands

| Command | What it does |
|---|---|
| `ctx init [--from <profile>] [--add <dir>,...] [--as <name>]` | Create the store and pick its seed. |
| `ctx add <dir>... [--as <name>]` | Manage a profile outside `~/.claude-*`, or rename one. |
| `ctx sync [profile...] [--all] [--force]` | Move a profile's data into the store and symlink it back. |
| `ctx status` (aliases `ls`, `st`) | Per-profile, per-item state in one grid, plus Claude dirs not yet managed. |
| `ctx run <profile> [-- <args>]` | Launch `claude` with the shared registry in place. |
| `ctx detach [profile...] [--all] [--force]` | Give a profile back its own independent copies. |
| `ctx doctor [profile...]` (alias `repair`) | Find and repair broken or misdirected links, and flag real copies where a link should be. |
| `ctx registry <show\|pull\|push\|diff>` | Drive the `.claude.json` split by hand. |
| `ctx hooks <status\|install\|uninstall>` | Wire sessions you did not start with `ctx run` into the store. |
| `ctx which [profile]` | Print the `CLAUDE_CONFIG_DIR` export for a profile. |

Flags: `-n/--dry-run`, `-y/--yes`, `-v/--verbose`, `--json`, `--only a,b`,
`--store <path>`, `--force`.

## Safety

The tool is built so an interrupted run is always safe to re-run.

- Real data is moved, never deleted. It goes into the store, or into
  `<store>/.backups/<profile>/<timestamp>/`. The only things `ctx` deletes
  outright are a symlink it is about to replace and directories with no files
  left in them. A file that turns up mid-merge goes to the backup.
- `sync` and `detach` refuse a profile while `claude` is running in it, going by
  the `sessions/<pid>.json` files Claude keeps. Close those sessions, or pass
  `--force` if you know better. Session files left by a crashed `claude` are
  ignored.
- Links are swapped with a rename, so a path is never briefly missing for a
  running session to recreate as a real directory.
- Everything that changes the store runs under one lock, so two `ctx`
  processes, or two sessions ending at once, take turns.
- Every step runs in the order merge, back up, then link, so the store is a
  superset before a profile's copy goes away.
- Directories are merged without clobbering. When the same path exists on both
  sides the store copy wins and yours is kept in the backup, reported by count
  at the end.
- Identity files are guarded in code, not just in config.
- Every destructive command prints its plan and asks once.
- `ctx detach` reads from the live store, not from backups, so it works even if
  you deleted them.
- The store holds everything sensitive Claude keeps apart from logins:
  transcripts, prompt history, and MCP server settings that may carry API keys.
  Treat it like `~/.claude`. Its registry files are written `0600`.

## Undo

```sh
ctx hooks uninstall     # first, or every profile keeps a copy of the hook
ctx detach --all        # every profile gets real copies back
```

After that the profiles no longer use the store. Keep `~/.ctx-store` until you
are happy, since `.backups/` holds anything ctx displaced along the way, then
archive or remove it yourself.

## Caveats

- Linux. Symlink behavior on macOS should work the same way but is untested.
  Without `/proc`, a session or lock holder is recognised by pid alone, not pid
  and start time. Windows is out of scope.
- Two sessions writing the shared `projects/` at once is fine, since transcripts
  are separate files with unique ids.
- `history.jsonl` is a single append-only file, so two sessions writing it at
  once can interleave. Drop it from `shared` in `ctx.json` if that bothers you.
  It is also not merged when profiles are first folded in: the seed's history
  is kept, and every other profile's goes to its backup.
- Removing every MCP server, or every project, from one account reads as a
  reset and does not spread. Remove them one at a time, or edit
  `<store>/registry.json`, if that is really what you want.
- A session started without `ctx run` only gets the shared keys the next time
  that profile is pulled. The hook covers the push half only.
- `plugins/` caches marketplace checkouts. Sharing it is usually what you want
  and is in the defaults, but it is the item most likely to surprise you.

## Configuration

`~/.ctx-store/ctx.json`, written by `ctx init` and safe to edit:

```json
{
  "version": 1,
  "shared": ["projects", "todos", "skills", "settings.json"],
  "registryKeys": ["projects", "mcpServers"],
  "backup": true,
  "profiles": ["/home/me/work/.claude", { "dir": "/home/me/acme", "name": "acme-client" }],
  "seed": "default"
}
```

Unknown or guarded names in `shared` are dropped on load rather than rejected,
so a bad edit shares less instead of breaking the tool. `~/.claude` and every
`~/.claude-*` directory that is empty or holds something only Claude writes
there (`.claude.json`, `projects`, `settings.json` and so on) are discovered.
Other tools that live in `~/.claude-*`, and old `ctx` stores, are skipped.
`profiles` adds directories on top of those, by path or with a name, and is
what `ctx add` writes. A store that sits inside a profile, or the other way
round, is refused.

## Environment

| variable | effect |
|---|---|
| `CTX_STORE` | store location, same as `--store` |
| `CTX_HOME` | treat another directory as home, which is how the tests stay off yours |
| `CTX_DEBUG` | print a stack trace with unexpected errors |
| `NO_COLOR` | plain output |
| `CLAUDE_CONFIG_DIR` | read by the hook to know which profile a session belonged to |

## Testing

```sh
npm test
```

Tests run against throwaway directories under `$TMPDIR` via `CTX_HOME`, with
`HOME` also pointed at a throwaway directory and a fake `claude` first on
`PATH`, so they never read or write your real `~/.claude*` or start the real
`claude`.

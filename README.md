# ctx

One source of truth for every Claude Code account on a machine.

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
~/.ctx-store/              the only real copy
  projects/  skills/  agents/  commands/  rules/  plans/
  todos/  file-history/  plugins/
  settings.json  CLAUDE.md  history.jsonl
  registry.json               the shared half of .claude.json

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

Node 20 or newer.

```sh
npm install
npm run build
npm link          # optional, puts `ctx` on your PATH
```

Or run it in place with `node dist/cli.js <command>`.

## Quick start

```sh
ctx init            # create the store, seeded from ~/.claude
ctx sync --all      # fold every profile into it
ctx status          # see the result
ctx run me          # launch claude as ~/.claude-me, shared data
```

Nothing is written until you confirm. `--dry-run` prints the plan and stops,
`-y` skips the prompt.

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

`.credentials.json`, `.claude.json`, `policy-limits.json`,
`remote-settings.json`, `stats-cache.json`, `settings.local.json`,
`mcp-needs-auth-cache.json`

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

`ctx run <profile>` writes the shared keys in before launching and merges what
the session changed back out afterwards. `projects` merges per path and per
field, so two accounts working on different repos never erase each other.

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
into the store on exit. Only the push half is hookable: `SessionStart` fires
after Claude has already read `.claude.json`, so pulling there would be
overwritten by Claude's own next save. Pulling stays the job of `ctx run`.

## Commands

| Command | What it does |
|---|---|
| `ctx init [--from <profile>]` | Create the store and seed it. |
| `ctx sync [profile...] [--all]` | Move a profile's data into the store and symlink it back. |
| `ctx status` (alias `ls`) | Per-profile, per-item state in one grid. |
| `ctx run <profile> [-- <args>]` | Launch `claude` with the shared registry in place. |
| `ctx detach [profile...]` | Give a profile back its own independent copies. |
| `ctx doctor [profile...]` | Find and repair broken or misdirected links. |
| `ctx registry <show\|pull\|push\|diff>` | Drive the `.claude.json` split by hand. |
| `ctx hooks <status\|install\|uninstall>` | Wire sessions you did not start with `ctx run` into the store. |
| `ctx which [profile]` | Print the `CLAUDE_CONFIG_DIR` export for a profile. |

Flags: `-n/--dry-run`, `-y/--yes`, `-v/--verbose`, `--json`, `--only a,b`,
`--store <path>`.

## Safety

The tool is built so an interrupted run is always safe to re-run.

- Real data is moved, never deleted. It goes into the store, or into
  `<store>/.backups/<profile>/<timestamp>/`. The only thing `ctx` deletes
  outright is a symlink it is about to replace.
- Every step runs in the order merge, back up, then link, so the store is a
  superset before a profile's copy goes away.
- Directories are merged without clobbering. When the same path exists on both
  sides the store copy wins and yours is kept in the backup, reported by count
  at the end.
- Identity files are guarded in code, not just in config.
- Every destructive command prints its plan and asks once.
- `ctx detach` reads from the live store, not from backups, so it works even if
  you deleted them.

## Caveats

- Linux. Symlink behavior on macOS should work the same way but is untested;
  Windows is out of scope.
- Two sessions writing the shared `projects/` at once is fine, since transcripts
  are separate files with unique ids. Prefer to close running sessions before
  `sync` or `detach`, because the move step could race a live writer.
- `history.jsonl` is a single append-only file, so two sessions writing it at
  once can interleave. Drop it from `shared` in `ctx.json` if that bothers you.
- The `.claude.json` merge is last-writer-wins per key, per project. Two
  sessions that end at the same moment are serialised by a lock, but the later
  one still wins on any field they both touched.
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
  "profiles": []
}
```

Unknown or guarded names in `shared` are dropped on load rather than rejected,
so a bad edit shares less instead of breaking the tool. An empty `profiles`
means auto-discover every `~/.claude` and `~/.claude-*` directory.

## Testing

```sh
npm test
```

Tests run against throwaway directories under `$TMPDIR` via `CTX_HOME`, and
never read or write your real `~/.claude*`.

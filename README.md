# ctx

Manage multiple Claude CLI accounts and share context across them.

Claude Code keeps both its config and its context in one directory (default
`~/.claude`, overridable with `CLAUDE_CONFIG_DIR`). If you run more than one
account, for example:

```sh
CLAUDE_CONFIG_DIR=~/.claude-work claude
```

then each account has its own isolated directory, and your session history
(`projects/`), skills, rules, and settings are siloed per account. `ctx` fixes
that: it keeps each account's identity separate (credentials and auth) while
sharing the context and reusable assets through one canonical store, using
symlinks.

## How it works

A single store at `~/.claude-shared/` holds the real copies of the shared
items. Each account directory gets a symlink into the store:

```
~/.claude-shared/projects/        <- real files live here
~/.claude/projects        -> ~/.claude-shared/projects
~/.claude-work/projects   -> ~/.claude-shared/projects
```

Identity and account-scoped state stay per account and are never touched:
`.credentials.json`, `.claude.json`, `policy-limits.json`, `remote-settings.json`,
`settings.local.json`, and the various caches.

## Install

Requires Node 20+.

```sh
npm install
npm run build
npm link        # optional, puts `ctx` on your PATH
```

Or run it directly: `node dist/cli.js <command>`.

## Quick start

```sh
ctx init            # create the store, pick what to sync, seed from ~/.claude
ctx link --all      # symlink every account into the store
ctx status          # check the result
ctx run work        # launch: CLAUDE_CONFIG_DIR=~/.claude-work claude
```

`ctx init` is interactive: it lists the shareable items it finds and lets you
toggle which ones to sync before writing the config. Pass `-y` to accept the
defaults non-interactively.

## Commands

| Command | What it does |
|---|---|
| `ctx accounts` (alias `ls`) | List account dirs and a link-status rollup. |
| `ctx init [--from <account>]` | Create and seed the store; choose what to sync. |
| `ctx link [account] [--all] [--only <items...>] [--force] [--no-backup]` | Merge an account's items into the store, back up the originals, and replace them with symlinks. |
| `ctx unlink [account] [--all] [--only <items...>]` | Replace symlinks with independent real copies of the current store content. |
| `ctx status [account]` | Per-account, per-item state (linked / unlinked / adoptable / broken). |
| `ctx repair [account] [--all]` | Fix broken or wrong-target symlinks. |
| `ctx run <account> [-- <claude args...>]` | Launch `claude` for an account. |

Global flags (usable before or after the subcommand): `--dry-run`, `-y/--yes`,
`--json`, `--verbose`, `--config <path>`, `--store <path>`.

Every destructive command prints its plan first. Without `-y` it asks once
before proceeding; `--dry-run` shows the plan and changes nothing.

## What gets shared

Defaults (shared when present, skipped when absent):

- Directories: `projects`, `todos`, `commands`, `agents`, `output-styles`,
  `skills`, `rules`, `plugins`, `plans`
- Files: `settings.json`, `CLAUDE.md`, `history.jsonl`

You choose the actual set during `ctx init`. It is stored in
`~/.claude-shared/ctx.config.json`, which you can edit by hand. The tool refuses
to share anything listed as protected (`neverTouch`), so a bad edit cannot turn
your credentials into a symlink.

## Safety

- Real replacements always run in the order merge/seed, then back up, then
  symlink, so the store holds a superset before the account's copy is removed.
  An interrupted run is safe to re-run.
- Originals are moved to `~/.claude-shared/.ctx-backups/<account>/<timestamp>/`
  before being replaced. Use `--no-backup` to skip.
- When a file (for example `CLAUDE.md`) differs between an account and the
  store, the store wins. `ctx link` skips such files unless you pass `--force`
  (or `-y`); the account's version is preserved in the backup either way.
- `unlink` never depends on backups; it copies the live store content back out.

## Caveats

- Two `claude` processes writing to the shared `projects/` at once is fine:
  sessions are separate files with unique ids. Prefer to close running sessions
  before `link`/`unlink`, since the move/replace step could race a live writer.
- `history.jsonl` and `plugins/` are shareable but higher risk (append races and
  per-account repo paths, respectively). They are in the defaults because they
  were opted in; uncheck them in `ctx init` if you would rather not.
- Session transcripts become physically shared, but each account's
  `.claude.json` still holds its own project registry and per-project trust.
  Sessions show up from the `projects/` directory on disk; project-level trust
  and MCP settings remain per account.
- Linux, Node 20+. Windows and macOS symlink behavior is out of scope for now.

## Testing

Unit and integration tests run against temporary directories and never touch
your real `~/.claude*`:

```sh
npm test
```

An end-to-end check runs entirely inside a container against a throwaway home:

```sh
docker build -f test/docker/Dockerfile -t ctx-e2e .
docker run --rm ctx-e2e
```

## Status

This focuses on the Claude CLI. Support for other AI CLIs may come later.

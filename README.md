# ctx: context portability for AI coding CLIs

You use multiple AI coding CLIs (Claude Code, puku-cli, Gemini CLI, Codex CLI, Aider). When you switch CLIs mid-task, your conversation context is gone. You re-explain the project, re-paste file contents, re-state constraints.

`ctx` is a standalone CLI that **exports** a session from one CLI into a portable JSON envelope, and **imports** it into another CLI's workflow as a paste-friendly markdown handoff (and, optionally, as a synthetic native JSONL for Claude/puku).

## v0.1 status

- ✅ Adapters: **claude** (Claude Code), **puku** (puku-cli)
- ✅ Commands: `detect`, `list`, `show`, `export`, `import`, `schema`
- ✅ Streaming everywhere (handles 100 MB+ sessions)
- ✅ `--write-native` for synthetic JSONL on Claude/puku
- ✅ `--redact` for shareable exports
- ✅ `--decision` to carry forward notes/decisions
- 🔜 v0.2: gemini + codex adapters
- 🔜 v0.3: aider adapter + `--summarize`

## Install

```bash
npm install -g @rijverse/ctx
# or for development:
npm install
npm run build
npm link
```

Requires Node.js 20+.

## Usage

```bash
# 1. Detect which CLIs have sessions for the current project
cd ~/your-project
ctx detect

# 2. List sessions
ctx list                       # most recent first
ctx list --tool claude --recent 5
ctx list --json

# 3. Show a session summary
ctx show 70311239              # by id or prefix

# 4. Export a session to portable JSON
ctx export 70311239 -o handoff.json
ctx export 70311239 --redact -o handoff.json   # strip tool_result bodies

# 5. Import into another CLI
ctx import handoff.json --to puku                          # markdown handoff
ctx import handoff.json --to puku --write-native           # also synthetic JSONL
ctx import handoff.json --to puku --dry-run                # preview
ctx import handoff.json --to puku \
  --decision "Use TypeScript strict" \
  --decision "Prefer functional components"
```

## The portable schema

`ctx schema` emits the portable session schema as JSON Schema. The shape:

```json
{
  "schema_version": "1.0",
  "source": { "tool": "claude|puku|gemini|codex|aider", "version": "...", "exported_at": "ISO8601" },
  "session": { "id": "...", "started_at": "...", "cwd": "...", "git_branch": "...", "model": "..." },
  "system": "string | [ContentBlock]",
  "messages": [{ "role": "user|assistant|system", "content": "string | [ContentBlock]", ... }],
  "tools": [...],
  "decisions": ["optional, user-provided context to carry forward"]
}
```

`ContentBlock` is a discriminated union aligned with Anthropic's content-block model: `text`, `thinking`, `redacted_thinking`, `tool_use`, `tool_result`. This gives the best round-trip fidelity with Claude-flavored CLIs.

## Import strategies

`ctx import` always writes a `.ctx-handoff.md` next to your project's target cwd. Paste that into the new CLI as initial context.

For Claude Code and puku-cli, you can also pass `--write-native` to drop a synthetic JSONL into the CLI's own `~/.claude/projects/<encodedCwd>/` (or `~/.puku-cli/projects/...`) directory. The synthetic chain mimics the real schema (with a fresh `last-prompt` pointing at the leaf) so the CLI treats it as a brand-new session and appends to it.

**Caveats for `--write-native`:**

- The synthetic chain uses generated UUIDs, not the originals from the source CLI.
- The `parentUuid` chain is rebuilt from scratch in conversation order; tools that diff sessions may notice.
- Only Claude Code and puku-cli are supported; for Gemini/Codex/Aider, use the markdown handoff.

## Privacy

`ctx` never makes network calls. All processing is local.

Use `--redact` on export to strip tool_result bodies (which may contain file contents, command output, or secrets) before sharing.

## Architecture

```
src/
├── schema/portable.ts        # zod schema for the portable envelope
├── adapters/                 # one Adapter per CLI
│   ├── types.ts              # Adapter interface, SessionRef, ImportOptions
│   ├── claude-family.ts      # shared base for Claude Code + puku-cli
│   ├── claude.ts, puku.ts    # thin shells over the family base
│   └── registry.ts           # auto-registers and detects adapters
├── normalizers/
│   └── claude-jsonl.ts       # reconstructs the conversation thread by
│                             # walking parentUuid from the last-prompt
├── render/
│   ├── markdown-handoff.ts   # → paste-friendly Markdown
│   └── native-claude.ts      # → synthetic JSONL for claude/puku
├── io/
│   ├── readJsonlStream.ts    # line-streamed JSON parser
│   └── paths.ts              # cwd encoding, root dir resolution
└── commands/                 # one file per subcommand
    ├── detect.ts
    ├── list.ts
    ├── show.ts
    ├── export.ts
    ├── import.ts
    └── schema.ts
```

## Development

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest run
npm run test:watch
npm run lint       # tsc --noEmit
```

## Roadmap

- **v0.2**: Gemini CLI + Codex CLI adapters. Gemini needs `$set` patch replay; Codex needs `state_*.sqlite` version-globbing and dynamic `pragma_table_info` SELECTs. Auto-populate `decisions` from Codex `memories_*.sqlite.rollout_summary`.
- **v0.3**: Aider markdown parser (synthesize IDs from `cwd + firstUserLine + fileMtime`). `--summarize` flag with BYO model endpoint for `decisions` auto-population. `ctx diff <a> <b>` for round-trip sanity checks.

## License

MIT
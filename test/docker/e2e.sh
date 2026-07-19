#!/usr/bin/env bash
# Full lifecycle check on fabricated account dirs. No real credentials involved.
set -euo pipefail

CLI="node /app/dist/cli.js"
H="$HOME"

fail() { echo "ASSERT FAILED: $*" >&2; exit 1; }
is_symlink()   { [ -L "$1" ] || fail "expected symlink: $1"; }
is_real_file() { [ -f "$1" ] && [ ! -L "$1" ] || fail "expected real file: $1"; }
has_file()     { [ -f "$1" ] || fail "missing file: $1"; }

# --- fabricate two accounts (default + work), overlapping project ---
mkdir -p "$H/.claude/projects/-proj" "$H/.claude/skills" "$H/.claude-work/projects/-proj"
printf 'default-sess\n'    > "$H/.claude/projects/-proj/s1.jsonl"
printf 'SETTINGS\n'        > "$H/.claude/settings.json"
printf 'default-memory\n'  > "$H/.claude/CLAUDE.md"
printf 'skill\n'           > "$H/.claude/skills/s1.md"
printf 'FAKE-CREDS\n'      > "$H/.claude/.credentials.json"
printf '{}\n'              > "$H/.claude/.claude.json"
printf 'work-sess\n'       > "$H/.claude-work/projects/-proj/s2.jsonl"
printf 'SETTINGS\n'        > "$H/.claude-work/settings.json"
printf 'FAKE-WORK-CREDS\n' > "$H/.claude-work/.credentials.json"
printf '{}\n'              > "$H/.claude-work/.claude.json"

echo "== ctx init =="
$CLI init -y
echo "== ctx link --all =="
$CLI link --all -y
echo "== ctx status --json =="
$CLI status --json

echo "== assert linked =="
is_symlink "$H/.claude/projects"
is_symlink "$H/.claude/settings.json"
is_symlink "$H/.claude/CLAUDE.md"
is_symlink "$H/.claude-work/projects"
is_symlink "$H/.claude-work/skills"   # adopted: work had none

echo "== assert identity untouched =="
is_real_file "$H/.claude/.credentials.json"
is_real_file "$H/.claude/.claude.json"
is_real_file "$H/.claude-work/.credentials.json"
is_real_file "$H/.claude-work/.claude.json"

echo "== assert store merged both sessions =="
has_file "$H/.claude-shared/projects/-proj/s1.jsonl"
has_file "$H/.claude-shared/projects/-proj/s2.jsonl"

echo "== ctx unlink --all =="
$CLI unlink --all -y
[ -L "$H/.claude-work/projects" ] && fail "still a symlink after unlink"
has_file "$H/.claude-work/projects/-proj/s1.jsonl"  # merged content survived
has_file "$H/.claude-work/projects/-proj/s2.jsonl"
is_real_file "$H/.claude-work/.credentials.json"

echo "ALL E2E ASSERTIONS PASSED"

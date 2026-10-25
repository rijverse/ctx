#!/usr/bin/env bash
# Install ctx from GitHub until the npm package is published:
#
#   curl -fsSL https://raw.githubusercontent.com/rijverse/ctx/main/install.sh | bash
#
# Downloads the source, builds it into ~/.local/share/ctx and links ctx into
# ~/.local/bin. `ctx update` updates it later, and so does running this again.
#
#   CTX_REF          branch, tag or commit to install (default main)
#   CTX_INSTALL_DIR  where the build goes
#   CTX_BIN_DIR      where the ctx link goes
set -euo pipefail

repo="rijverse/ctx"
ref="${CTX_REF:-main}"
dir="${CTX_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/ctx}"
bin="${CTX_BIN_DIR:-$HOME/.local/bin}"

short() { printf '%s' "${1/#"$HOME"/'~'}"; }
stop() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

# All of it sits in main, so a download cut off halfway runs nothing.
main() {
  case "$(uname -s)" in
    Linux | Darwin) ;;
    *) stop "ctx runs on Linux and macOS only." ;;
  esac
  for tool in curl tar node npm; do
    command -v "$tool" >/dev/null || stop "$tool is required and was not found on PATH."
  done
  node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' ||
    stop "ctx needs Node 20 or newer, this is $(node --version)."

  # Only ever replace a directory a previous run put there, since CTX_INSTALL_DIR
  # can point anywhere.
  if [[ -e $dir ]] && ! grep -qs '"name": "@rijverse/ctx"' "$dir/package.json"; then
    stop "$(short "$dir") exists and is not a ctx install. Move it or set CTX_INSTALL_DIR."
  fi
  if [[ -e $bin/ctx && ! -L $bin/ctx ]]; then
    stop "$(short "$bin/ctx") exists and is not a link. Move it or set CTX_BIN_DIR."
  fi

  mkdir -p "$(dirname "$dir")" "$bin"
  bin="$(cd "$bin" && pwd)"
  tmp="$(mktemp -d "$(dirname "$dir")/.ctx-install.XXXXXX")"
  trap 'rm -rf "$tmp"' EXIT

  # Pinned to a commit so the install can say what it is, and `ctx update` can
  # tell when there is something newer. If GitHub will not say, the ref itself
  # is downloaded and the commit stays unknown.
  commit="$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$repo/commits/$ref" 2>/dev/null || true)"
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || commit=""

  printf 'Downloading %s@%s%s\n' "$repo" "$ref" "${commit:+ (${commit:0:7})}"
  curl -fsSL "https://github.com/$repo/archive/${commit:-$ref}.tar.gz" | tar -xz -C "$tmp" --strip-components=1 ||
    stop "could not download $ref from github.com/$repo."

  # Chained with && because set -e does not apply on the left of ||.
  printf 'Building\n'
  (cd "$tmp" &&
    npm ci --no-audit --no-fund --loglevel=error >/dev/null &&
    npm run build --silent &&
    npm prune --omit=dev --no-audit --no-fund --loglevel=error >/dev/null) ||
    stop "the build failed. Nothing was installed."

  node -e '
    const [file, repo, ref, commit, bin] = process.argv.slice(1);
    require("fs").writeFileSync(file, JSON.stringify({ repo, ref, commit: commit || null, bin }, null, 2) + "\n");
  ' "$tmp/install.json" "$repo" "$ref" "$commit" "$bin"

  # Build next to the old install and swap at the end, so a failed update
  # leaves the working one alone.
  rm -rf "$dir"
  mv "$tmp" "$dir"
  ln -sfn "$dir/dist/cli.js" "$bin/ctx"

  printf 'Installed ctx %s to %s\n' "$("$dir/dist/cli.js" version)" "$(short "$dir")"
  case ":$PATH:" in
    *":$bin:"*)
      local found
      found="$(command -v ctx || true)"
      if [[ -n $found && $found != "$bin/ctx" ]]; then
        printf 'Note: %s comes first on PATH, so `ctx` still runs that one.\n' "$(short "$found")"
      fi
      ;;
    *) printf 'Add %s to PATH to run `ctx`, or call %s directly.\n' "$(short "$bin")" "$(short "$bin/ctx")" ;;
  esac
}

main "$@"

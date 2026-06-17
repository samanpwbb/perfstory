#!/bin/sh
# Install perftale as a personal Claude skill + a global `perftale` command.
#
# perftale's CLI imports this repo's src/ and node_modules, so the global
# command is ALWAYS a symlink back to this clone — it cannot run detached.
# That makes "link" the only sensible default (the reverse of a distributable
# skill, which would default to copying).
#
# Usage:
#   ./install.sh           # symlink skill dir + global bin back to this repo (default)
#   ./install.sh --copy    # copy SKILL.md into a standalone skill dir; bin still symlinked
#
# Existing files at the targets are backed up with a .bak-<timestamp> suffix,
# unless they already point where we want (then we leave them alone).
#
# Override the global command location with BIN_DIR (default: ~/.local/bin):
#   BIN_DIR=~/bin ./install.sh

set -e

MODE="link"
if [ "$1" = "--copy" ]; then
  MODE="copy"
elif [ -n "$1" ]; then
  echo "Usage: $0 [--copy]" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
SKILL_TARGET="$CLAUDE_DIR/skills/perftale"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
BIN_TARGET="$BIN_DIR/perftale"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$CLAUDE_DIR/skills" "$BIN_DIR"

backup_if_exists() {
  path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    backup="${path}.bak-${TIMESTAMP}"
    echo "  backing up existing $path -> $backup"
    mv "$path" "$backup"
  fi
}

# Symlink $src -> $dst, but skip if it already points there (keeps re-runs clean).
link() {
  src="$1"
  dst="$2"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$src" ]; then
    echo "  ok      $dst already -> $src"
    return
  fi
  backup_if_exists "$dst"
  ln -s "$src" "$dst"
  echo "  linked  $dst -> $src"
}

echo "Installing perftale (mode: $MODE)"

# --- sanity checks (warn, don't fail) ---
if [ ! -d "$REPO_DIR/node_modules" ]; then
  echo "  WARNING: $REPO_DIR/node_modules missing — run 'pnpm install' or the CLI will fail."
fi

if command -v node >/dev/null 2>&1; then
  # Node >= 23.6 runs the .ts CLI with no build step (type stripping on by default).
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$NODE_MAJOR" -lt 23 ] || { [ "$NODE_MAJOR" -eq 23 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
    echo "  WARNING: Node $(node -v) is < v23.6 — perftale needs native TypeScript support."
  fi
else
  echo "  WARNING: node not found on PATH."
fi

# --- skill ---
if [ "$MODE" = "link" ]; then
  link "$REPO_DIR" "$SKILL_TARGET"
else
  backup_if_exists "$SKILL_TARGET"
  mkdir -p "$SKILL_TARGET"
  cp "$REPO_DIR/SKILL.md" "$SKILL_TARGET/SKILL.md"
  echo "  copied  $REPO_DIR/SKILL.md -> $SKILL_TARGET/SKILL.md"
fi

# --- global command (always a symlink; the CLI needs the repo) ---
chmod +x "$REPO_DIR/bin/perftale.ts"
link "$REPO_DIR/bin/perftale.ts" "$BIN_TARGET"

# --- PATH check ---
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "  NOTE: $BIN_DIR is not on your PATH — add it so the 'perftale' command resolves." ;;
esac

cat <<EOF

----------------------------------------------------------------------
Installed. Verify with:

  perftale            # prints usage
  perftale analyze <trace.json[.gz]>

Optional: pre-approve the analyzer in ~/.claude/settings.json under
permissions.allow so the skill runs without prompting (also in permissions.json):

EOF

cat "$REPO_DIR/permissions.json"

cat <<EOF

Then RESTART Claude Code so the new skill is discovered.
----------------------------------------------------------------------
EOF

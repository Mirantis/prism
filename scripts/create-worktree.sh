#!/usr/bin/env bash
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "Usage: $0 <worktree-name>"
  exit 1
fi

NAME="$1"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="$REPO_ROOT/.claude/worktrees/$NAME"

if [ -d "$WORKTREE_DIR" ]; then
  echo "Error: worktree already exists at $WORKTREE_DIR"
  exit 1
fi

WORKTREE_BRANCH="worktree/$NAME"

echo "Fetching latest from remote..."
git fetch --all

echo "Creating worktree '$NAME' from origin/main..."
WORKTREE_PARENT_DIR="$(dirname "$WORKTREE_DIR")"
mkdir -p "$WORKTREE_PARENT_DIR"
git worktree add -b "$WORKTREE_BRANCH" "$WORKTREE_DIR" origin/main

# Copy .env files, preserving directory structure
ENV_FILES=(
  ".env"
  "web/.env.local"
)

for env_file in "${ENV_FILES[@]}"; do
  src="$REPO_ROOT/$env_file"
  if [ -f "$src" ]; then
    dest="$WORKTREE_DIR/$env_file"
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "Copied $env_file"
  else
    echo "Skipped $env_file (not found)"
  fi
done

# Symlink node_modules from main repo (faster than copy or npm install)
echo "Linking node_modules..."
while IFS= read -r -d '' nm_dir; do
  rel="${nm_dir#"$REPO_ROOT/"}"
  dest="$WORKTREE_DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  ln -s "$nm_dir" "$dest"
  echo "Linked $rel"
done < <(find "$REPO_ROOT" -name "node_modules" -maxdepth 4 -type d -not -path "*/node_modules/*/node_modules*" -not -path "*/.claude/*" -print0)

# Regenerate the Prisma client against THIS worktree's schema. node_modules
# (and so the single generated client) is shared via the symlinks above, so a
# different worktree's last `prisma generate` may leave the client expecting
# columns this branch doesn't have ("column ... does not exist" at runtime).
# Re-baking it here aligns the client with the worktree we just created.
echo "Generating Prisma client for this worktree's schema..."
if ! ( cd "$WORKTREE_DIR" && npx prisma generate --schema=prisma/sqlite/schema.prisma ); then
  echo "Warning: prisma generate failed — run it manually in the worktree before \`npm run dev\`."
fi

echo ""
echo "Worktree ready at $WORKTREE_DIR"
echo "Starting Claude Code..."
exec claude --worktree "$NAME"

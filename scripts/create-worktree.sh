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

# Give the worktree its own copy of the SQLite database(s) so it starts from a
# snapshot of the current data and never writes to the source repo's DB. This
# matters because node_modules — and so the single generated Prisma client that
# resolves the relative `file:./agent.db` URL — is symlinked across worktrees,
# so without isolation a worktree can clobber another worktree's (or main's) DB.
SQLITE_REL="prisma/sqlite"
if [ -d "$REPO_ROOT/$SQLITE_REL" ]; then
  echo "Copying SQLite database files..."
  mkdir -p "$WORKTREE_DIR/$SQLITE_REL"
  shopt -s nullglob
  for db in "$REPO_ROOT/$SQLITE_REL"/*.db "$REPO_ROOT/$SQLITE_REL"/*.db-wal "$REPO_ROOT/$SQLITE_REL"/*.db-shm; do
    cp "$db" "$WORKTREE_DIR/$SQLITE_REL/"
    echo "Copied $SQLITE_REL/$(basename "$db")"
  done
  shopt -u nullglob
fi

# Pin DATABASE_URL to this worktree's own agent.db by absolute path, so the
# shared Prisma client can't resolve the relative URL to a different worktree's
# database. Only rewrites a SQLite (file:) URL; other setups are left alone.
WORKTREE_ENV="$WORKTREE_DIR/.env"
WORKTREE_DB="$WORKTREE_DIR/$SQLITE_REL/agent.db"
if [ -f "$WORKTREE_ENV" ] && grep -q '^DATABASE_URL=file:' "$WORKTREE_ENV"; then
  sed -i.bak "s#^DATABASE_URL=.*#DATABASE_URL=file:$WORKTREE_DB#" "$WORKTREE_ENV"
  rm -f "$WORKTREE_ENV.bak"
  echo "Pinned DATABASE_URL to file:$WORKTREE_DB"
fi

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

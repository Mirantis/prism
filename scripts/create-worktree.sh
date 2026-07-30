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

# Symlink node_modules from main repo (faster than copy or npm install), except
# the top-level one — see below.
echo "Linking node_modules..."
while IFS= read -r -d '' nm_dir; do
  rel="${nm_dir#"$REPO_ROOT/"}"
  [ "$rel" = "node_modules" ] && continue
  dest="$WORKTREE_DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  ln -s "$nm_dir" "$dest"
  echo "Linked $rel"
done < <(find "$REPO_ROOT" -name "node_modules" -maxdepth 4 -type d -not -path "*/node_modules/*/node_modules*" -not -path "*/.claude/*" -print0)

# The top-level node_modules is deliberately NOT symlinked. It is a real
# directory holding nothing but this worktree's own generated Prisma client, so
# that `prisma generate` here cannot rewrite any other worktree's client.
#
# Why a copy and not a link: the generated client is code with the column list
# baked in, and `@prisma/client` is a shim that does
# `require('.prisma/client/default')`. That bare specifier resolves from wherever
# the shim physically sits, so a symlinked `@prisma/client` resolves straight back
# to the source repo and the private `.prisma` is ignored. Both have to be real.
# Sharing them means one worktree's `prisma generate` — run directly, or by
# `predev` or `prisma migrate dev` — leaves every other worktree's runtime
# querying a column its database lacks ("The column ... does not exist in the
# current database").
#
# `prisma` (the CLI) is only symlinked: it needs to be *resolvable* or the CLI
# decides the project is missing its packages and runs a full `npm install` into
# the worktree — 1.5G and a modified package.json. It does not need to be private.
#
# Nothing else is duplicated. The worktree lives inside the repo, so Node
# resolves anything absent here by walking up to $REPO_ROOT/node_modules, and npm
# puts each ancestor's node_modules/.bin on PATH. Cost is ~96M per worktree.
echo "Giving the worktree its own Prisma client..."
mkdir -p "$WORKTREE_DIR/node_modules/@prisma"
for prisma_dir in ".prisma" "@prisma/client"; do
  src="$REPO_ROOT/node_modules/$prisma_dir"
  if [ -d "$src" ]; then
    cp -R "$src" "$WORKTREE_DIR/node_modules/$prisma_dir"
    echo "Copied node_modules/$prisma_dir"
  else
    echo "Skipped node_modules/$prisma_dir (not found — run npm install in the source repo)"
  fi
done
if [ -d "$REPO_ROOT/node_modules/prisma" ]; then
  ln -s "$REPO_ROOT/node_modules/prisma" "$WORKTREE_DIR/node_modules/prisma"
  echo "Linked node_modules/prisma (CLI)"
fi

# Bake the private client against THIS worktree's schema — the copy above is a
# snapshot of whatever the source repo last generated, which may be another
# branch's shape. Invoked via the source repo's binary rather than `npx`, which
# would try to install into the worktree.
echo "Generating Prisma client for this worktree's schema..."
if ! ( cd "$WORKTREE_DIR" && "$REPO_ROOT/node_modules/.bin/prisma" generate --schema=prisma/sqlite/schema.prisma ); then
  echo "Warning: prisma generate failed — run it manually in the worktree before \`npm run dev\`."
fi

echo ""
echo "Worktree ready at $WORKTREE_DIR"
echo "Starting Claude Code..."
exec claude --worktree "$NAME"

#!/usr/bin/env node
/**
 * Assemble the prism-server sidecar for the host platform.
 *
 * The prism-server SEA bundle keeps its native deps external; at runtime the
 * extracted bundle resolves them from a `node_modules/` that sits next to the
 * binary. This copies that closure — better-sqlite3, @prisma/client (+ the
 * generated .prisma/client engine), sqlite-vec (+ the platform subpkg) and
 * their transitive deps — into `dist-sea/<os-arch>/node_modules`, and the
 * built SPA into `dist-sea/<os-arch>/web`.
 *
 * Run AFTER `npm run build:web` and `node scripts/build-sea.mjs prism-server`.
 */
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const ROOT_MODULES = path.join(ROOT, 'node_modules');

const ROOTS = ['better-sqlite3', '@prisma/client', 'sqlite-vec'];

/** Resolve a package's install dir (handles hoisting + restrictive `exports`). */
function pkgDir(name) {
  // Try the well-known subpath first.
  try {
    return path.dirname(require.resolve(`${name}/package.json`, { paths: [ROOT] }));
  } catch {}
  // Fall back to resolving the main entry and walking up — needed when
  // `exports` blocks `./package.json` (e.g. sqlite-vec).
  try {
    let dir = path.dirname(require.resolve(name, { paths: [ROOT] }));
    while (dir !== path.dirname(dir)) {
      if (existsSync(path.join(dir, 'package.json'))) return dir;
      dir = path.dirname(dir);
    }
  } catch {}
  // Last resort: the platform-specific sub-packages (e.g. sqlite-vec-darwin-arm64)
  // expose neither a main entry nor `./package.json` via exports — look directly
  // under the project's node_modules.
  const direct = path.join(ROOT_MODULES, ...name.split('/'));
  if (existsSync(path.join(direct, 'package.json'))) return direct;
  throw new Error(`could not locate ${name}`);
}

/** Transitive dep closure (deps + optionalDeps), skipping anything missing. */
function closure(roots) {
  const found = new Map(); // name -> dir
  const stack = [...roots];
  const seen = new Set();
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    let dir;
    try {
      dir = pkgDir(name);
    } catch {
      continue; // optional / platform-specific / not installed — fine
    }
    found.set(name, dir);
    const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys({ ...pj.dependencies, ...pj.optionalDependencies })) {
      stack.push(dep);
    }
  }
  return found;
}

const OUTDIR = path.join(ROOT, 'dist-sea', `${process.platform}-${process.arch}`);
const OUT_MODULES = path.join(OUTDIR, 'node_modules');
mkdirSync(OUT_MODULES, { recursive: true });

// 1. Copy the dependency closure of the native packages.
const pkgs = closure(ROOTS);
for (const [name, dir] of pkgs) {
  const dest = path.join(OUT_MODULES, ...name.split('/'));
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(dir, dest, { recursive: true, dereference: true });
  console.log(`[collect-natives] ${name}`);
}

// 2. The generated Prisma client + query engine (a sibling dir, not a package
//    dependency, so the closure walk misses it).
const prismaGen = path.join(ROOT_MODULES, '.prisma');
if (existsSync(prismaGen)) {
  cpSync(prismaGen, path.join(OUT_MODULES, '.prisma'), { recursive: true, dereference: true });
  console.log('[collect-natives] .prisma/client (generated + engine)');
} else {
  const message = '[collect-natives] ERROR: node_modules/.prisma not found — run `npm run prisma:generate`';
  console.error(message);
  throw new Error(message);
}

// 3. The built web UI.
const webDist = path.join(ROOT, 'web', 'dist');
if (existsSync(webDist)) {
  const destWeb = path.join(OUTDIR, 'web');
  rmSync(destWeb, { recursive: true, force: true });
  cpSync(webDist, destWeb, { recursive: true });
  console.log('[collect-natives] web/');
} else {
  console.error('[collect-natives] WARNING: web/dist not found — run `npm run build:web`');
}

console.log(`[collect-natives] done: ${OUTDIR}`);

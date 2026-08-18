#!/usr/bin/env node
/**
 * Build a Node.js Single Executable Application (SEA) for one target.
 *
 *   node scripts/build-sea.mjs prism         # the Ink TUI — fully self-contained
 *   node scripts/build-sea.mjs prism-server  # the runtime — needs the sidecar
 *                                            # lib/ + web/ from collect-natives.mjs
 *
 * ink 7 + yoga + the runtime's deps use top-level await, which esbuild cannot
 * emit to CommonJS — and a SEA's `main` is run as CommonJS, not ESM. So we
 * bundle to ESM, embed that bundle as a SEA *asset*, and make the SEA's CJS
 * main a tiny stub that extracts the asset to a temp file and dynamic-imports
 * it. Pipeline: esbuild bundle -> SEA blob -> copy `node` -> postject inject ->
 * (re)sign on macOS. SEA binaries embed a platform-specific node — run per OS.
 */
import { build } from 'esbuild';
import { inject } from 'postject';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const target = process.argv[2];
if (target !== 'prism' && target !== 'prism-server') {
  console.error('usage: node scripts/build-sea.mjs <prism|prism-server>');
  process.exit(1);
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/**
 * Deps that cannot go through the bundler, needed by both targets.
 *
 * - `playwright-core` reaches esbuild as a prebuilt bundle whose optional
 *   `chromium-bidi/...` imports don't resolve, so bundling it fails outright. It is
 *   only ever loaded by a lazy `import()` in `services/meeting/browser-stack.ts`,
 *   which a binary never reaches: a SEA ships no Chromium, Xvfb or PulseAudio, so
 *   `isBrowserAvailable()` leaves the meeting tools unregistered at startup. An
 *   external that can't resolve at runtime is therefore unreachable, not broken.
 * - `fsevents` is a macOS-only native addon pulled in transitively by file watchers;
 *   esbuild has no loader for its `.node` file.
 */
const UNBUNDLABLE = ['playwright-core', 'fsevents'];

const TARGETS = {
  prism: {
    entry: 'cli/src/index.tsx',
    external: [...UNBUNDLABLE],
  },
  'prism-server': {
    entry: 'src/sea/server-entry.ts',
    // Native addons + sidecar-loaded modules + pino's worker-thread transport.
    external: ['better-sqlite3', '@prisma/client', 'sqlite-vec', 'pino-pretty', ...UNBUNDLABLE],
  },
};
const cfg = TARGETS[target];

// esbuild plugin: stub optional deps ink only loads under DEV=true (the
// react-devtools-core import is otherwise unresolved and fails the build).
const stubOptional = {
  name: 'stub-optional',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({ path: args.path, namespace: 'stub-optional' }));
    b.onLoad({ filter: /.*/, namespace: 'stub-optional' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} };',
      loader: 'js',
    }));
  },
};

// esbuild plugin: inline prisma/sqlite/migrations/*/migration.sql as the
// default export of `virtual:migrations`, so prism-server can replay them
// at boot without the Prisma CLI (see src/sea/migrate.ts).
const virtualMigrations = {
  name: 'virtual-migrations',
  setup(b) {
    b.onResolve({ filter: /^virtual:migrations$/ }, (args) => ({ path: args.path, namespace: 'virtual-migrations' }));
    b.onLoad({ filter: /.*/, namespace: 'virtual-migrations' }, () => {
      const dir = path.join(ROOT, 'prisma', 'sqlite', 'migrations');
      const names = readdirSync(dir)
        .filter((n) => statSync(path.join(dir, n)).isDirectory())
        .sort();
      const migrations = names.map((name) => ({
        name,
        sql: readFileSync(path.join(dir, name, 'migration.sql'), 'utf8'),
      }));
      return { contents: `export default ${JSON.stringify(migrations)};`, loader: 'js' };
    });
  },
};

const BUILD = path.join(ROOT, 'build', 'sea');
const OUTDIR = path.join(ROOT, 'dist-sea', `${process.platform}-${process.arch}`);
mkdirSync(BUILD, { recursive: true });
mkdirSync(OUTDIR, { recursive: true });

const bundlePath = path.join(BUILD, `${target}.mjs`);
const stubPath = path.join(BUILD, `${target}.stub.cjs`);
const blobPath = path.join(BUILD, `${target}.blob`);
const seaConfigPath = path.join(BUILD, `${target}.sea.json`);
const binPath = path.join(OUTDIR, isWin ? `${target}.exe` : target);

// 1. Bundle the entry to a single ESM file.
console.log(`[build-sea] bundling ${cfg.entry}`);
await build({
  entryPoints: [path.join(ROOT, cfg.entry)],
  bundle: true,
  platform: 'node',
  format: 'esm',
  // Match the SEA runtime pin (Node 22 — see .github/workflows/create-binary.yml
  // and the "SEA binaries" note in AGENTS.md for why we can't go higher yet).
  target: 'node22',
  outfile: bundlePath,
  external: cfg.external,
  define: { 'process.env.PRISM_VERSION': JSON.stringify(version) },
  plugins: [stubOptional, virtualMigrations],
  // ESM output: give esbuild's `__require` shim a real require + provide the
  // CJS globals bundled deps expect (signal-exit etc. `require('assert')`).
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_fn } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirname_fn(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});

// 2. CJS stub: extract the ESM bundle (a SEA asset) and dynamic-import it.
//    prism is self-contained (per-process temp dir). prism-server must extract
//    NEXT TO the executable so its external bare imports resolve from the
//    sidecar node_modules/ that ships alongside it; concurrent starts (service
//    restart overlap, two processes) write to a per-PID/nonce tmp file first
//    and atomically rename into place, so no caller ever observes a partial
//    bundle.
const extractBlock =
  target === 'prism-server'
    ? `const dir = path.dirname(process.execPath);
const finalFile = path.join(dir, '.prism-server.runtime.mjs');
const tmpFile = path.join(
  dir,
  '.prism-server.runtime.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp',
);
fs.writeFileSync(tmpFile, Buffer.from(getAsset('main.mjs')));
let file = finalFile;
try {
  fs.renameSync(tmpFile, finalFile);
} catch {
  // Windows can refuse to replace an in-use dest; our tmpFile is fully
  // written and resolves externals from the same directory, so use it.
  file = tmpFile;
}`
    : `const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prism-sea-')), 'main.mjs');
fs.writeFileSync(file, Buffer.from(getAsset('main.mjs')));`;

writeFileSync(
  stubPath,
  `'use strict';
const { getAsset } = require('node:sea');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
${extractBlock}
import(pathToFileURL(file).href).catch((err) => { console.error(err); process.exit(1); });
`,
);

// 3. Generate the SEA preparation blob (embeds the ESM bundle as an asset).
writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: stubPath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      assets: { 'main.mjs': bundlePath },
    },
    null,
    2,
  ),
);
console.log('[build-sea] generating SEA blob');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

// 4. Copy the running node binary to use as the executable base.
rmSync(binPath, { force: true });
copyFileSync(process.execPath, binPath);
chmodSync(binPath, 0o755);

// 5. macOS: strip the existing signature before mutating the binary.
if (isMac) {
  try {
    execFileSync('codesign', ['--remove-signature', binPath], { stdio: 'inherit' });
  } catch {
    // already unsigned — fine
  }
}

// 6. Inject the blob (postject's programmatic API — cross-platform).
console.log('[build-sea] injecting blob with postject');
await inject(binPath, 'NODE_SEA_BLOB', readFileSync(blobPath), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(isMac ? { machoSegmentName: 'NODE_SEA' } : {}),
});

// 7. macOS: ad-hoc re-sign so the kernel will run the mutated binary.
if (isMac) {
  execFileSync('codesign', ['--sign', '-', binPath], { stdio: 'inherit' });
}

console.log(`[build-sea] done: ${binPath}`);

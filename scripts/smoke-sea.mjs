#!/usr/bin/env node
/**
 * Smoke-test the built SEA binaries for the host platform.
 *
 *   prism         --version prints a semver and exits 0
 *   prism-server  --version prints a semver; boots, serves /health 200 and
 *                 the SPA at /, then shuts down cleanly
 *   LICENSE, NOTICE, THIRD_PARTY_NOTICES are present
 *
 * Runs in CI (all OSes) and locally. Expects dist-sea/<os-arch>/ populated by
 * scripts/build-binaries.sh.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ext = process.platform === 'win32' ? '.exe' : '';
const dir = path.join(ROOT, 'dist-sea', `${process.platform}-${process.arch}`);
const prism = path.join(dir, `prism${ext}`);
const server = path.join(dir, `prism-server${ext}`);

function ok(name) {
  console.log(`✓ ${name}`);
}
function fail(name) {
  console.error(`✗ ${name}`);
  process.exit(1);
}

// 1. --version on both binaries.
const v = execFileSync(prism, ['--version'], { encoding: 'utf8' }).trim();
/\d+\.\d+\.\d+/.test(v) ? ok(`prism --version (${v})`) : fail('prism --version');
const sv = execFileSync(server, ['--version'], { encoding: 'utf8' }).trim();
/\d+\.\d+\.\d+/.test(sv) ? ok(`prism-server --version (${sv})`) : fail('prism-server --version');

// 2. The archive carries the license, attribution and third-party notices.
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES']) {
  existsSync(path.join(dir, name)) ? ok(`${name} present`) : fail(`${name} present`);
}

// 3. prism-server boots against an isolated home, serves /health + the SPA.
const home = mkdtempSync(path.join(os.tmpdir(), 'prism-smoke-'));
const child = spawn(server, [], {
  env: {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: 'production',
    // Don't connect to Slack during the smoke test.
    SLACK_BOT_TOKEN: '',
    SLACK_APP_TOKEN: '',
    // Nor reach a model registry. Off by default, but this spreads process.env
    // and boots for real on every OS in CI, so pin it: the bundled catalog is what
    // the binary ships with anyway.
    MODELS_DEV_URL: '',
  },
  stdio: 'inherit',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  try {
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch('http://127.0.0.1:3003/health')).ok) {
          healthy = true;
          break;
        }
      } catch {
        // not up yet
      }
      await sleep(500);
    }
    if (!healthy) fail('prism-server /health 200');
    ok('prism-server /health 200');

    const html = await (await fetch('http://127.0.0.1:3003/')).text();
    /<!doctype html/i.test(html) ? ok('prism-server GET / serves SPA') : fail('prism-server GET / serves SPA');
  } finally {
    child.kill('SIGTERM');
  }
  console.log('SEA smoke tests passed.');
}

main().catch((err) => {
  child.kill('SIGTERM');
  console.error(err);
  process.exit(1);
});

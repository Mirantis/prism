/**
 * Runs `playwright test` with the arguments it is given. `--shard=<current>/<total>` is
 * planned by recorded duration (`shard-plan.ts`) instead of by test count: this lists the
 * suite under the same filters, keeps the files the plan gives this shard, and runs them
 * as a `--test-list`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planShards, type SpecFile } from './shard-plan';

/** Seconds per spec file from a green CI run; `update-web-shard-timings.ts` rewrites it. */
const TIMINGS_FILE = path.join(__dirname, 'web-shard-timings.json');

interface ListedSuite {
  file: string;
  specs: { tests: unknown[] }[];
  suites?: ListedSuite[];
}

const SHARD = /^--shard=(\d+)\/(\d+)$/;
const args = process.argv.slice(2);
const shardArg = args.find((a) => SHARD.test(a));
const playwrightArgs = args.filter((a) => a !== shardArg);

function playwright(extra: string[], opts: { env?: NodeJS.ProcessEnv; quiet?: boolean } = {}): number {
  const result = spawnSync('npx', ['playwright', 'test', ...extra, ...playwrightArgs], {
    stdio: opts.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
    env: opts.env ?? process.env,
  });
  return result.status ?? 1;
}

function countTests(suite: ListedSuite): number {
  const own = suite.specs.reduce((n, spec) => n + spec.tests.length, 0);
  return own + (suite.suites ?? []).reduce((n, child) => n + countTests(child), 0);
}

function listSpecFiles(dir: string): SpecFile[] {
  const listFile = path.join(dir, 'list.json');
  const status = playwright(['--list', '--reporter=json'], {
    env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: listFile },
    quiet: true,
  });
  if (status !== 0) process.exit(status);
  const report = JSON.parse(fs.readFileSync(listFile, 'utf8')) as { suites: ListedSuite[] };
  return report.suites.map((suite) => ({ file: suite.file, tests: countTests(suite) }));
}

if (!shardArg) process.exit(playwright([]));

const [current, total] = shardArg.match(SHARD)!.slice(1).map(Number);
if (current < 1 || current > total) throw new Error(`${shardArg}: the shard must be 1 to ${total}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-shard-'));
const recorded = JSON.parse(fs.readFileSync(TIMINGS_FILE, 'utf8')) as Record<string, number>;
const shard = planShards(listSpecFiles(dir), recorded, total)[current - 1];
const testList = path.join(dir, 'test-list.txt');
fs.writeFileSync(testList, shard.files.map((f) => f.file).join('\n') + '\n');

console.log(
  `[e2e] Shard ${current}/${total}: ${shard.files.length} files, planned ${Math.round(shard.seconds)}s\n` +
    shard.files.map((f) => `  ${f.file}`).join('\n'),
);
process.exit(playwright([`--test-list=${testList}`]));

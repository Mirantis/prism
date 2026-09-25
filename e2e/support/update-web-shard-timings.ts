/**
 * Rewrites `web-shard-timings.json` from a Playwright JSON report of a whole, green web
 * run: the `results.json` in the `playwright-report` artifact of the E2E workflow.
 *
 *   npx tsx support/update-web-shard-timings.ts path/to/results.json
 *
 * A file's time is the sum of its tests' final attempts.
 */

import fs from 'node:fs';
import path from 'node:path';

interface ReportSuite {
  file: string;
  specs: { tests: { results: { duration: number }[] }[] }[];
  suites?: ReportSuite[];
}

function milliseconds(suite: ReportSuite): number {
  const own = suite.specs
    .flatMap((spec) => spec.tests)
    .reduce((ms, test) => ms + (test.results.at(-1)?.duration ?? 0), 0);
  return own + (suite.suites ?? []).reduce((ms, child) => ms + milliseconds(child), 0);
}

const reportPath = process.argv[2];
if (!reportPath) throw new Error('usage: update-web-shard-timings.ts <results.json>');

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { suites: ReportSuite[] };
const seconds: Record<string, number> = {};
for (const suite of [...report.suites].sort((a, b) => (a.file < b.file ? -1 : 1))) {
  seconds[suite.file] = Math.round(milliseconds(suite) / 100) / 10;
}
fs.writeFileSync(
  path.join(__dirname, 'web-shard-timings.json'),
  JSON.stringify(seconds, null, 2) + '\n',
);
console.log(`[e2e] Recorded ${Object.keys(seconds).length} spec files`);

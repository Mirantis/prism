/**
 * Answers the runtime's chat and classification calls (`generateText`, `generateObject`) from the
 * e2e LLM cache (agentic-evals). A call whose prompt, tools and settings match a recorded one gets
 * the recorded response; any other call goes to the model and is recorded.
 * `AGENTIC_EVALS_CACHE_MODE=off` runs every call live.
 *
 * The runtime loads this before anything else, because a module that loads `ai` before
 * `register()` keeps calling the model directly.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheStats, register } from 'agentic-evals/register';
import { LLM_CACHE_DIR, LLM_CACHE_STATS_DIR } from './llm-cache-files';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

register({
  cacheDir: LLM_CACHE_DIR,
  variables: {
    // The system prompt's date line.
    date: /(?<=Today's date \(UTC\): )\d{4}-\d{2}-\d{2} \(\w+\)/,
    // A point in time in a tool result, as `toISOString()` and `toLocaleString()` print it.
    time: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z|\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}(?:\s[AP]M)?/,
    // Directories under the temp dir: its path differs per machine, and the TUI suite's
    // directories end in a random suffix.
    tmp: new RegExp(`${escapeRegExp(os.tmpdir())}/[\\w.-]+`),
    // Thread, message, attachment, goal and task ids are new on every run.
    uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  },
});

// Playwright stops the runtime with SIGKILL, so the counts are written when they change. The
// suite's teardown reads them while the runtime still runs, so each write replaces the file whole.
const statsFile = path.join(LLM_CACHE_STATS_DIR, `${process.pid}.json`);
let written = '';
setInterval(() => {
  const counts = JSON.stringify(cacheStats());
  if (counts === written) return;
  fs.mkdirSync(LLM_CACHE_STATS_DIR, { recursive: true });
  fs.writeFileSync(`${statsFile}.tmp`, counts);
  fs.renameSync(`${statsFile}.tmp`, statsFile);
  written = counts;
}, 1000).unref();

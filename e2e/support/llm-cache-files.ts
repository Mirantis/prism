/**
 * The e2e LLM cache's files, for the test processes. Only the runtime registers the cache
 * (`llm-cache.ts`), so nothing here imports agentic-evals.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LLM_CACHE_DIR = process.env.AGENTIC_EVALS_CACHE_DIR || path.join(__dirname, '..', 'llm-cache');

/** One file of counts per runtime process; a suite's teardown adds them up. */
export const LLM_CACHE_STATS_DIR = path.join(os.tmpdir(), 'prism-e2e-llm-cache-stats');

interface Counts {
  hits: number;
  misses: number;
  savedMs: number;
}

/**
 * Removes the entries written since `since`. A scenario that failed may have recorded the response
 * that failed it, and its retry would replay that response. The file time decides, so a call still
 * running when its scenario timed out writes its entry afterwards, and that entry stays.
 */
export function forgetLlmCacheEntriesSince(since: number, cacheDir = LLM_CACHE_DIR): void {
  if (!fs.existsSync(cacheDir)) return;
  for (const entry of fs.readdirSync(cacheDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(entry.parentPath, entry.name);
    if (fs.statSync(file).mtimeMs >= since) fs.rmSync(file, { force: true });
  }
}

export function resetLlmCacheStats(): void {
  fs.rmSync(LLM_CACHE_STATS_DIR, { recursive: true, force: true });
}

/** Prints the suite's hits, misses and saved model time, and adds them to the GitHub job summary. */
export function reportLlmCacheStats(suite: string, statsDir = LLM_CACHE_STATS_DIR): string | undefined {
  if (!fs.existsSync(statsDir)) return undefined;
  const total: Counts = { hits: 0, misses: 0, savedMs: 0 };
  // A runtime writes `<pid>.json.tmp` and renames it, so only whole files end in `.json`.
  for (const name of fs.readdirSync(statsDir).filter((file) => file.endsWith('.json'))) {
    const counts = JSON.parse(fs.readFileSync(path.join(statsDir, name), 'utf-8')) as Counts;
    total.hits += counts.hits;
    total.misses += counts.misses;
    total.savedMs += counts.savedMs;
  }

  const line =
    `LLM cache (${suite}): ${total.hits} hits, ${total.misses} misses, ` +
    `${Math.round(total.savedMs / 1000)} s of model time saved`;
  console.log(`[e2e] ${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  return line;
}

/**
 * The runtime the suites start, and the environment they start it with.
 *
 * The runtime is the `prism-server` binary. `PRISM_SERVER_BIN` names another build;
 * otherwise the suites run the release build in this checkout
 * (`cargo build --release` in `runtime/`).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LLM_CACHE_DIR, LLM_CACHE_STATS_DIR } from './llm-cache-files';
import { MANAGED_VOICE_KEY, MANAGED_VOICE_PATH } from './managed-voice';
import { MOCK_REALTIME_PORT } from './mock-realtime-port';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const PRISM_SERVER_BIN =
  process.env.PRISM_SERVER_BIN || path.join(REPO_ROOT, 'runtime', 'target', 'release', 'prism-server');

/** Fails with the command to run when the binary has not been built. */
export function assertRuntimeBuilt(): void {
  if (fs.existsSync(PRISM_SERVER_BIN)) return;
  throw new Error(
    `The runtime binary ${PRISM_SERVER_BIN} does not exist. ` +
      'Build it with `cargo build --release` in runtime/, or set PRISM_SERVER_BIN.',
  );
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Run-specific text the LLM cache replaces with a placeholder before it hashes a call, as
 * regular expression sources. A call matches a recording when everything else is the same.
 */
export const LLM_CACHE_VARIABLES: Record<string, string> = {
  // The system prompt's date line.
  date: String.raw`(?<=Today's date \(UTC\): )\d{4}-\d{2}-\d{2} \(\w+\)`,
  // A point in time in a tool result, as `toISOString()`, `toLocaleString()` and the
  // scheduling tools print it.
  time: String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z|\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}(?:\s[AP]M)?|[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M GMT(?:[+-]\d{1,2}(?::\d{2})?)?`,
  // Directories under the temp dir: its path differs per machine, and the TUI suite's
  // directories end in a random suffix.
  tmp: `${escapeRegExp(os.tmpdir())}/[\\w.-]+`,
  // Thread, message, attachment, goal and task ids are new on every run.
  uuid: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
};

/** The environment that puts the e2e LLM cache in front of the runtime's model calls. */
export function llmCacheEnv(): Record<string, string> {
  return {
    PRISM_LLM_CACHE_DIR: LLM_CACHE_DIR,
    PRISM_LLM_CACHE_STATS_DIR: LLM_CACHE_STATS_DIR,
    PRISM_LLM_CACHE_VARIABLES: JSON.stringify(LLM_CACHE_VARIABLES),
  };
}

/**
 * The web suite's runtime environment on top of the Playwright config's: real managed voice
 * discovery against the mock Realtime server, and the LLM cache. OpenRouter precedes Azure in
 * the provider list but cannot serve Realtime; chat keeps its own configured provider.
 */
export function webSuiteRuntimeEnv(): Record<string, string> {
  return {
    OPENAI_REALTIME_URL: '',
    OPENAI_REALTIME_API_KEY: '',
    LENS_MANAGED_INFERENCE_PROVIDER: 'bedrock',
    LENS_MANAGED_INFERENCE_PROVIDERS: '["bedrock","openrouter","azure"]',
    LENS_INFERENCE_AZURE_OPENAI_BASE_URL: `http://127.0.0.1:${MOCK_REALTIME_PORT}${MANAGED_VOICE_PATH}`,
    LENS_INFERENCE_AZURE_OPENAI_API_KEY: MANAGED_VOICE_KEY,
    ...llmCacheEnv(),
  };
}

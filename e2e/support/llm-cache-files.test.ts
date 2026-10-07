import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetLlmCacheEntriesSince, reportLlmCacheStats } from './llm-cache-files';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-cache-files-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const writeEntry = (name: string, mtimeMs: number) => {
  const file = path.join(dir, 'bedrock.anthropic.messages', 'model', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
};

describe('forgetLlmCacheEntriesSince', () => {
  it('removes the entries written since the scenario started and keeps the older ones', () => {
    const startedAt = Date.now();
    const recorded = writeEntry('recorded.json', startedAt - 60_000);
    const failed = writeEntry('failed.json', startedAt + 1_000);

    forgetLlmCacheEntriesSince(startedAt, dir);

    expect(fs.existsSync(recorded)).toBe(true);
    expect(fs.existsSync(failed)).toBe(false);
  });

  it('does nothing when no cache has been recorded', () => {
    expect(() => forgetLlmCacheEntriesSince(Date.now(), path.join(dir, 'missing'))).not.toThrow();
  });
});

describe('reportLlmCacheStats', () => {
  it('adds up the counts of every runtime and skips a file still being written', () => {
    fs.writeFileSync(path.join(dir, '101.json'), JSON.stringify({ hits: 3, misses: 1, savedMs: 4_400 }));
    fs.writeFileSync(path.join(dir, '102.json'), JSON.stringify({ hits: 2, misses: 4, savedMs: 1_200 }));
    fs.writeFileSync(path.join(dir, '103.json.tmp'), '{"hits":');

    expect(reportLlmCacheStats('web', dir)).toBe('LLM cache (web): 5 hits, 5 misses, 6 s of model time saved');
  });

  it('reports nothing when no runtime wrote counts', () => {
    expect(reportLlmCacheStats('web', path.join(dir, 'missing'))).toBeUndefined();
  });
});

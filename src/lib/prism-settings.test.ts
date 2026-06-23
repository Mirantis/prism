/**
 * Tests for the ~/.prism/settings.json reader that supplies agent-creation
 * model defaults. Exercises a real temp file through `readAgentModelDefaults`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAgentModelDefaults } from './prism-settings';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-settings-'));
  file = path.join(dir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(obj: unknown): void {
  fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
}

describe('readAgentModelDefaults', () => {
  it('reads modelId, heartbeatModelId and cronModelId', () => {
    write({
      modelId: 'us.anthropic.claude-opus-4-8',
      heartbeatModelId: 'us.anthropic.claude-haiku-4-5',
      cronModelId: 'us.anthropic.claude-sonnet-4-6',
    });
    expect(readAgentModelDefaults(file)).toEqual({
      model: 'us.anthropic.claude-opus-4-8',
      heartbeatModel: 'us.anthropic.claude-haiku-4-5',
      cronModel: 'us.anthropic.claude-sonnet-4-6',
    });
  });

  it('returns {} when the file is missing', () => {
    expect(readAgentModelDefaults(path.join(dir, 'nope.json'))).toEqual({});
  });

  it('returns {} on malformed JSON', () => {
    write('{ not json');
    expect(readAgentModelDefaults(file)).toEqual({});
  });

  it('returns {} when the JSON is not an object', () => {
    write('["a", "b"]');
    expect(readAgentModelDefaults(file)).toEqual({});
  });

  it('leaves unset overrides absent (so callers fall back to null)', () => {
    write({ modelId: 'us.anthropic.claude-opus-4-8' });
    const result = readAgentModelDefaults(file);
    // toEqual treats an undefined-valued key as absent, which is what callers
    // (`?? null`) rely on.
    expect(result).toEqual({ model: 'us.anthropic.claude-opus-4-8' });
    expect(result.heartbeatModel ?? null).toBeNull();
    expect(result.cronModel ?? null).toBeNull();
  });

  it('ignores blank, non-string, and malformed model ids', () => {
    write({ modelId: '   ', heartbeatModelId: 42, cronModelId: 'has spaces' });
    expect(readAgentModelDefaults(file)).toEqual({});
  });

  it('trims surrounding whitespace from a valid id', () => {
    write({ modelId: '  us.anthropic.claude-opus-4-8  ' });
    expect(readAgentModelDefaults(file)).toEqual({ model: 'us.anthropic.claude-opus-4-8' });
  });
});

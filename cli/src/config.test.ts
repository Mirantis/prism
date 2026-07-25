import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { loadConfig, wsUrlFromHttpUrl } from './config.js';

describe('loadConfig', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
    delete process.env.PRISM_HTTP_URL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = origEnv;
  });

  it('returns the bundled defaults when the settings file is missing', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const cfg = loadConfig();
    expect(cfg.agentName).toBe('Prism');
    expect(cfg.modelId).toBe('us.anthropic.claude-opus-5');
    expect(cfg.hideCursor).toBe(false);
    expect(cfg.hideStatusBar).toBe(false);
    expect(cfg.httpUrl).toBe('http://localhost:3003');
  });

  it('PRISM_HTTP_URL env overrides the default when no file is present', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    process.env.PRISM_HTTP_URL = 'http://127.0.0.1:54321';
    const cfg = loadConfig();
    expect(cfg.httpUrl).toBe('http://127.0.0.1:54321');
  });

  it('PRISM_HTTP_URL env overrides the value from a present settings file', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ httpUrl: 'http://example.com:9999' }),
    );
    process.env.PRISM_HTTP_URL = 'http://127.0.0.1:54321';
    const cfg = loadConfig();
    expect(cfg.httpUrl).toBe('http://127.0.0.1:54321');
  });

  it('reads file values when no env override is set', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        agentName: 'Custom',
        modelId: 'us.anthropic.claude-sonnet-4-5-20250929',
        hideCursor: true,
        hideStatusBar: true,
        httpUrl: 'http://example.com:9999',
      }),
    );
    const cfg = loadConfig();
    expect(cfg.agentName).toBe('Custom');
    expect(cfg.modelId).toBe('us.anthropic.claude-sonnet-4-5-20250929');
    expect(cfg.hideCursor).toBe(true);
    expect(cfg.hideStatusBar).toBe(true);
    expect(cfg.httpUrl).toBe('http://example.com:9999');
  });

  it('falls back to defaults for wrong-typed keys', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ hideCursor: 'yes', modelId: 42 }),
    );
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const cfg = loadConfig();
    expect(cfg.hideCursor).toBe(false);
    expect(cfg.modelId).toBe('us.anthropic.claude-opus-5');
  });
});

describe('wsUrlFromHttpUrl', () => {
  it('converts http to ws and appends /api/ws', () => {
    expect(wsUrlFromHttpUrl('http://localhost:3003')).toBe('ws://localhost:3003/api/ws');
  });

  it('converts https to wss and appends /api/ws', () => {
    expect(wsUrlFromHttpUrl('https://example.com')).toBe('wss://example.com/api/ws');
  });

  it('strips a trailing slash before appending /api/ws', () => {
    expect(wsUrlFromHttpUrl('http://localhost:3003/')).toBe('ws://localhost:3003/api/ws');
  });
});

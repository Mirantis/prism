import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockTrackEvent } = vi.hoisted(() => ({ mockTrackEvent: vi.fn() }));
vi.mock('./telemetry', () => ({ trackEvent: mockTrackEvent, isTelemetryEnabled: () => false }));

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../logger', () => ({ logger: mockLogger }));

vi.mock('../config', () => ({
  config: {
    llmProvider: 'bedrock' as 'bedrock' | 'azure',
    contextWindowTokens: null as number | null,
    modelsDevUrl: null as string | null,
  },
}));

import { config } from '../config';
import {
  bundledModelCatalog,
  cancelModelCatalogRefresh,
  refreshModelCatalog,
  installRemoteCatalog,
  isUsableRegistryEntry,
  modelCatalog,
  modelCatalogState,
  reshapeRegistry,
  resetModelCatalog,
  MIN_PLAUSIBLE_CONTEXT,
} from './model-catalog';
import { contextWindowFor } from './context-window';

const BEDROCK_CHAT_DEFAULT = 'us.anthropic.claude-opus-5';
const AZURE_CHAT_DEFAULT = 'claude-opus-5';

/** A minimal models.dev-shaped payload. */
function registry(overrides: Record<string, unknown> = {}) {
  return {
    'amazon-bedrock': {
      models: {
        'us.anthropic.claude-opus-5': { limit: { context: 1_000_000, output: 128_000 } },
        'amazon.titan-embed-text-v2:0': { limit: { context: 8_192, output: 0 } },
      },
    },
    azure: {
      models: {
        'claude-opus-5': { limit: { context: 1_000_000, output: 128_000 } },
      },
    },
    ...overrides,
  };
}

describe('model catalog', () => {
  beforeEach(() => {
    resetModelCatalog();
    config.llmProvider = 'bedrock';
    config.contextWindowTokens = null;
    config.modelsDevUrl = null;
  });

  describe('the bundled floor at rest', () => {
    it('serves the bundled catalog before any refresh', () => {
      expect(modelCatalog()).toEqual(bundledModelCatalog());
      expect(modelCatalogState()).toBe('bundled');
    });

    it('resolves the runtime defaults with every entry tagged bundled', () => {
      expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({
        tokens: 1_000_000,
        source: 'snapshot',
      });
      const entries = Object.values(bundledModelCatalog().bedrock ?? {});
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e?.origin === 'bundled')).toBe(true);
    });
  });

  describe('isUsableRegistryEntry', () => {
    it('keeps Claude-family models with a believable window', () => {
      expect(isUsableRegistryEntry('claude-opus-5', { limit: { context: 1_000_000 } })).toBe(true);
      expect(isUsableRegistryEntry('anthropic.claude-fable-5', { limit: { context: 200_000 } })).toBe(true);
    });

    it('drops non-Claude models', () => {
      expect(isUsableRegistryEntry('amazon.titan-embed-text-v2:0', { limit: { context: 8_192 } })).toBe(false);
      expect(isUsableRegistryEntry('gpt-5', { limit: { context: 400_000 } })).toBe(false);
    });

    it('drops an implausibly small or missing window', () => {
      // A handful-of-tokens window renders "100% context used" forever, which is the
      // exact failure the indicator exists to avoid.
      expect(isUsableRegistryEntry('claude-opus-5', { limit: { context: 0 } })).toBe(false);
      expect(isUsableRegistryEntry('claude-opus-5', { limit: { context: -1 } })).toBe(false);
      expect(isUsableRegistryEntry('claude-opus-5', { limit: { context: 500 } })).toBe(false);
      expect(isUsableRegistryEntry('claude-opus-5', { limit: {} })).toBe(false);
      expect(isUsableRegistryEntry('claude-opus-5', {})).toBe(false);
    });

    it('accepts exactly at the floor', () => {
      expect(
        isUsableRegistryEntry('claude-opus-5', { limit: { context: MIN_PLAUSIBLE_CONTEXT } }),
      ).toBe(true);
    });
  });

  describe('reshapeRegistry', () => {
    it('scopes per provider, drops noise, normalizes a missing output', () => {
      const reshaped = reshapeRegistry(
        registry({
          azure: { models: { 'claude-opus-5': { limit: { context: 1_000_000 } } } },
        }),
      );

      expect(reshaped).toEqual({
        bedrock: {
          'us.anthropic.claude-opus-5': { context: 1_000_000, output: 128_000, origin: 'remote' },
        },
        azure: {
          'claude-opus-5': { context: 1_000_000, output: null, origin: 'remote' },
        },
      });
    });

    it('ignores providers it is not configured for', () => {
      const reshaped = reshapeRegistry({
        ...registry(),
        openai: { models: { 'claude-opus-5': { limit: { context: 1_000_000 } } } },
      });
      expect(Object.keys(reshaped!)).toEqual(['bedrock', 'azure']);
    });

    it('omits a provider that yielded nothing rather than emitting it empty', () => {
      // Absent, not empty — so the merge leaves that provider fully at bundled values.
      const reshaped = reshapeRegistry(
        registry({ azure: { models: { 'gpt-5': { limit: { context: 400_000 } } } } }),
      );
      expect(reshaped).not.toHaveProperty('azure');
      expect(reshaped).toHaveProperty('bedrock');
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an array', []],
      ['an empty object', {}],
      ['a string', 'nope'],
      ['providers absent', { openai: { models: {} } }],
      ['every entry unusable', { 'amazon-bedrock': { models: { 'gpt-5': { limit: { context: 9 } } } } }],
      ['models not an object', { 'amazon-bedrock': { models: 'oops' } }],
    ])('rejects %s', (_label, payload) => {
      expect(reshapeRegistry(payload)).toBeNull();
    });
  });

  describe('installRemoteCatalog', () => {
    it('lets the overlay win for an entry the bundle already had', () => {
      const before = contextWindowFor(BEDROCK_CHAT_DEFAULT);
      expect(before).toEqual({ tokens: 1_000_000, source: 'snapshot' });

      installRemoteCatalog({
        bedrock: {
          [BEDROCK_CHAT_DEFAULT]: { context: 2_000_000, output: 128_000, origin: 'remote' },
        },
      });

      expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({
        tokens: 2_000_000,
        source: 'remote',
      });
    });

    it('preserves bundle-only entries and keeps reporting them as snapshot', () => {
      installRemoteCatalog({
        bedrock: {
          [BEDROCK_CHAT_DEFAULT]: { context: 2_000_000, output: 128_000, origin: 'remote' },
        },
      });

      // Untouched by the overlay, so still the floor's number and the floor's label.
      config.llmProvider = 'azure';
      expect(contextWindowFor(AZURE_CHAT_DEFAULT)).toEqual({
        tokens: 1_000_000,
        source: 'snapshot',
      });
    });

    it('adds a model the bundle has never heard of', () => {
      expect(contextWindowFor('us.anthropic.claude-brandnew-9')).toBeNull();

      const result = installRemoteCatalog({
        bedrock: {
          'us.anthropic.claude-brandnew-9': { context: 5_000_000, output: 64_000, origin: 'remote' },
        },
      });

      expect(result.added).toBe(1);
      expect(result.changed).toBe(0);
      expect(contextWindowFor('us.anthropic.claude-brandnew-9')).toEqual({
        tokens: 5_000_000,
        source: 'remote',
      });
    });

    it('never mutates the imported JSON', () => {
      // The bundled map is a module singleton shared with anything else importing
      // it (the e2e steps do). Mutating it would corrupt the floor and poison the
      // diff counts, invisibly.
      const floorBefore = structuredClone(bundledModelCatalog());

      installRemoteCatalog({
        bedrock: {
          [BEDROCK_CHAT_DEFAULT]: { context: 2_000_000, output: 128_000, origin: 'remote' },
          'us.anthropic.claude-brandnew-9': { context: 5_000_000, output: null, origin: 'remote' },
        },
      });

      expect(bundledModelCatalog()).toEqual(floorBefore);
    });

    it('installs one provider and leaves the other entirely at bundled values', () => {
      const azureFloor = structuredClone(bundledModelCatalog().azure);

      installRemoteCatalog({
        bedrock: {
          [BEDROCK_CHAT_DEFAULT]: { context: 2_000_000, output: 128_000, origin: 'remote' },
        },
      });

      expect(modelCatalog().azure).toEqual(azureFloor);
      expect(modelCatalog().bedrock?.[BEDROCK_CHAT_DEFAULT]?.context).toBe(2_000_000);
    });

    it('counts a large divergence separately from an ordinary change', () => {
      const result = installRemoteCatalog({
        bedrock: {
          // 1M -> 900k: a real change, but within the noise band.
          [BEDROCK_CHAT_DEFAULT]: { context: 900_000, output: 128_000, origin: 'remote' },
          // 200k -> 20k: an order of magnitude down, worth a human look.
          'us.anthropic.claude-haiku-4-5-20251001-v1:0': {
            context: 20_000,
            output: 64_000,
            origin: 'remote',
          },
        },
      });

      expect(result.changed).toBe(2);
      expect(result.diverged).toBe(1);
    });

    it('does not count an identical value as changed', () => {
      const result = installRemoteCatalog({
        bedrock: {
          [BEDROCK_CHAT_DEFAULT]: { context: 1_000_000, output: 128_000, origin: 'remote' },
        },
      });
      expect(result).toEqual({ added: 0, changed: 0, diverged: 0 });
    });
  });

  describe('the env override still wins over everything', () => {
    it('beats an installed overlay', () => {
      installRemoteCatalog({
        bedrock: {
          [BEDROCK_CHAT_DEFAULT]: { context: 2_000_000, output: 128_000, origin: 'remote' },
        },
      });
      config.contextWindowTokens = 50_000;

      expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({ tokens: 50_000, source: 'env' });
    });
  });
});

// ============================================================================
// The boot-time refresh
// ============================================================================

describe('refreshModelCatalog', () => {
  const URL = 'https://models.dev/api.json';
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  }

  /** The single `model catalog refreshed` emission, or undefined. */
  function outcome() {
    const call = mockTrackEvent.mock.calls.find(([event]) => event === 'model catalog refreshed');
    return call?.[2] as Record<string, string> | undefined;
  }

  beforeEach(() => {
    resetModelCatalog();
    config.llmProvider = 'bedrock';
    config.contextWindowTokens = null;
    config.modelsDevUrl = URL;
    mockTrackEvent.mockClear();
    mockLogger.warn.mockClear();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('makes no outbound call when the URL is empty', async () => {
    config.modelsDevUrl = null;

    await refreshModelCatalog();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(modelCatalogState()).toBe('disabled');
    expect(modelCatalog()).toEqual(bundledModelCatalog());
    expect(outcome()).toBeUndefined();
  });

  it('installs the overlay on success and reports counts', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        registry({
          'amazon-bedrock': {
            models: {
              'us.anthropic.claude-opus-5': { limit: { context: 2_000_000, output: 128_000 } },
              'us.anthropic.claude-brandnew-9': { limit: { context: 5_000_000 } },
            },
          },
        }),
      ),
    );

    await refreshModelCatalog();

    expect(modelCatalogState()).toBe('remote');
    expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({ tokens: 2_000_000, source: 'remote' });
    expect(outcome()).toMatchObject({
      'catalog.outcome': 'remote',
      'catalog.new_entries': '1',
      'catalog.changed_entries': '1',
      'catalog.entries_bedrock': '2',
    });
  });

  it('sends an Accept header and the abort signal', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(registry()));

    await refreshModelCatalog();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ accept: 'application/json' });
  });

  it.each([
    ['an HTTP error', () => jsonResponse('', { status: 500 }), 'http', 'failed'],
    [
      'an HTML interstitial served as 200',
      () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      'shape',
      'rejected',
    ],
    ['a truncated body', () => jsonResponse('{"amazon-bedrock":'), 'parse', 'rejected'],
    ['a payload with no configured provider', () => jsonResponse({ openai: { models: {} } }), 'shape', 'rejected'],
  ])('keeps the bundled floor on %s', async (_label, respond, kind, reported) => {
    fetchSpy.mockResolvedValue(respond());

    await refreshModelCatalog();

    expect(modelCatalogState()).toBe('failed');
    expect(modelCatalog()).toEqual(bundledModelCatalog());
    expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({ tokens: 1_000_000, source: 'snapshot' });
    expect(outcome()).toMatchObject({ 'catalog.outcome': reported, 'catalog.failure_kind': kind });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('reports a timeout distinctly from a generic network failure', async () => {
    fetchSpy.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));

    await refreshModelCatalog();

    expect(outcome()).toMatchObject({ 'catalog.outcome': 'failed', 'catalog.failure_kind': 'timeout' });
    expect(modelCatalog()).toEqual(bundledModelCatalog());
  });

  it('reports a refused connection as a network failure', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    await refreshModelCatalog();

    expect(outcome()).toMatchObject({ 'catalog.failure_kind': 'network' });
  });

  it('never emits telemetry containing a URL', async () => {
    fetchSpy.mockRejectedValue(new TypeError(`connect ECONNREFUSED via http://proxy.internal:3128`));

    await refreshModelCatalog();

    expect(JSON.stringify(outcome())).not.toContain('proxy.internal');
    expect(JSON.stringify(outcome())).not.toContain('models.dev');
  });

  it('serves the bundled floor while the fetch is still in flight', async () => {
    // The whole point of keeping the lookup synchronous: an unfinished refresh has
    // simply not reassigned module state yet, so there is nothing to fall back to.
    let release!: (res: Response) => void;
    fetchSpy.mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));

    const pending = refreshModelCatalog();

    expect(modelCatalogState()).toBe('pending');
    expect(modelCatalog()).toEqual(bundledModelCatalog());
    expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({ tokens: 1_000_000, source: 'snapshot' });

    release(
      jsonResponse(
        registry({
          'amazon-bedrock': {
            models: { 'us.anthropic.claude-opus-5': { limit: { context: 2_000_000 } } },
          },
        }),
      ),
    );
    await pending;

    expect(modelCatalogState()).toBe('remote');
    expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({ tokens: 2_000_000, source: 'remote' });
  });

  it('aborts the in-flight request on cancellation without reporting an outcome', async () => {
    let capturedSignal: AbortSignal | undefined;
    fetchSpy.mockImplementation((_url, init) => {
      capturedSignal = (init as RequestInit).signal ?? undefined;
      const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      // Mirror real fetch: reject straight away if the signal is *already* aborted.
      // The refresh awaits the proxy dispatcher before fetching, so a cancel can
      // land before this call — and an 'abort' listener added afterwards never
      // fires. Getting this wrong hangs the test rather than failing it.
      if (capturedSignal?.aborted) return Promise.reject(abortError());
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => reject(abortError()));
      });
    });

    const pending = refreshModelCatalog();
    cancelModelCatalogRefresh();
    await pending;

    expect(capturedSignal?.aborted).toBe(true);
    // A shutdown cancellation is a non-event, not a failure.
    expect(outcome()).toBeUndefined();
    expect(modelCatalog()).toEqual(bundledModelCatalog());
  });

  it('warns but still installs when a remote window diverges sharply', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        registry({
          'amazon-bedrock': {
            models: { 'us.anthropic.claude-opus-5': { limit: { context: 100_000 } } },
          },
        }),
      ),
    );

    await refreshModelCatalog();

    expect(outcome()).toMatchObject({ 'catalog.diverged_entries': '1' });
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('diverge'));
    // Installed anyway: a rejection band would block a legitimate 200k -> 1M jump.
    expect(contextWindowFor(BEDROCK_CHAT_DEFAULT)).toEqual({ tokens: 100_000, source: 'remote' });
  });

  it('rejects a body that declares more than the size cap', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(registry(), { headers: { 'content-type': 'application/json', 'content-length': '99999999' } }),
    );

    await refreshModelCatalog();

    expect(modelCatalogState()).toBe('failed');
    expect(modelCatalog()).toEqual(bundledModelCatalog());
  });
});

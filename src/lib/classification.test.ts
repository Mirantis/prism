/**
 * Classification helpers — the seam between callers and vendor quirks.
 *
 * `getGateRequest()`/`getClassificationRequest()` exist so a caller like the
 * Slack thread classifier never names a vendor. These tests pin three things:
 * the active provider's options are passed through (and merged, one namespace
 * deep, on the structured-output path), a provider that declares none yields
 * an empty bag rather than `undefined` (which would read as "no opinion" at the
 * call site and is awkward to spread), and the model and options come from a
 * single `createProvider()` — the factory builds a credential chain and two SDK
 * clients, so a second construction on a per-message path is not free.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { config } from '../config';

const { mockCreateProvider } = vi.hoisted(() => ({
  mockCreateProvider: vi.fn(),
}));

vi.mock('./llm-providers/create-provider', () => ({
  createProvider: mockCreateProvider,
}));

import { getGateRequest, getClassificationRequest } from './classification';

/** A provider stub: callable, with the attached members under test. */
function providerStub(options?: {
  structuredOutputOptions?: Record<string, Record<string, string>>;
  classificationProviderOptions?: Record<string, Record<string, string>>;
  classificationMinOutputTokens?: number;
  classificationSamplingParams?: { temperature?: number };
}) {
  return Object.assign(vi.fn((modelId: string) => ({ modelId })), {
    embedding: vi.fn(),
    ...(options?.structuredOutputOptions
      ? { structuredOutputOptions: options.structuredOutputOptions }
      : {}),
    ...(options?.classificationProviderOptions
      ? { classificationProviderOptions: options.classificationProviderOptions }
      : {}),
    ...(options?.classificationMinOutputTokens !== undefined
      ? { classificationMinOutputTokens: options.classificationMinOutputTokens }
      : {}),
    ...(options?.classificationSamplingParams
      ? { classificationSamplingParams: options.classificationSamplingParams }
      : {}),
  });
}

describe('getGateRequest', () => {
  beforeEach(() => {
    config.classificationModelId = 'anthropic.claude-haiku-4-5';
  });

  it('resolves the configured classification model through the active provider', () => {
    const provider = providerStub();
    mockCreateProvider.mockReturnValue(provider);

    expect(getGateRequest().model).toEqual({ modelId: 'anthropic.claude-haiku-4-5' });
    expect(provider).toHaveBeenCalledWith('anthropic.claude-haiku-4-5');
  });

  it("passes through the provider's classification options", () => {
    mockCreateProvider.mockReturnValue(
      providerStub({ classificationProviderOptions: { openai: { reasoningEffort: 'none' } } }),
    );

    expect(getGateRequest().providerOptions).toEqual({ openai: { reasoningEffort: 'none' } });
  });

  it('does NOT include structured-output options — the gates are plain generateText', () => {
    mockCreateProvider.mockReturnValue(
      providerStub({ structuredOutputOptions: { anthropic: { structuredOutputMode: 'jsonTool' } } }),
    );

    expect(getGateRequest().providerOptions).toEqual({});
  });

  it('yields an empty bag when the provider declares none', () => {
    mockCreateProvider.mockReturnValue(providerStub());

    expect(getGateRequest().providerOptions).toEqual({});
  });

  it("carries the provider's output-token floor, defaulting to 0", () => {
    mockCreateProvider.mockReturnValue(providerStub());
    expect(getGateRequest().minOutputTokens).toBe(0);

    mockCreateProvider.mockReturnValue(providerStub({ classificationMinOutputTokens: 16 }));
    expect(getGateRequest().minOutputTokens).toBe(16);
  });

  it('defaults sampling params to deterministic temperature 0', () => {
    mockCreateProvider.mockReturnValue(providerStub());
    expect(getGateRequest().samplingParams).toEqual({ temperature: 0 });
  });

  it('lets the provider omit temperature entirely (empty sampling params)', () => {
    mockCreateProvider.mockReturnValue(providerStub({ classificationSamplingParams: {} }));
    expect(getGateRequest().samplingParams).toEqual({});
  });

  it('builds the provider once — it is not a cheap accessor', () => {
    mockCreateProvider.mockReturnValue(providerStub());

    getGateRequest();

    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
  });
});

describe('getClassificationRequest', () => {
  beforeEach(() => {
    config.classificationModelId = 'anthropic.claude-haiku-4-5';
  });

  it("passes through the active provider's options, with the configured model", () => {
    mockCreateProvider.mockReturnValue(
      providerStub({ structuredOutputOptions: { anthropic: { structuredOutputMode: 'jsonTool' } } }),
    );

    expect(getClassificationRequest()).toEqual({
      model: { modelId: 'anthropic.claude-haiku-4-5' },
      providerOptions: { anthropic: { structuredOutputMode: 'jsonTool' } },
      samplingParams: { temperature: 0 },
    });
  });

  it('is vendor-agnostic — whatever the provider declares is what comes back', () => {
    mockCreateProvider.mockReturnValue(
      providerStub({ structuredOutputOptions: { acme: { mode: 'widget' } } }),
    );

    expect(getClassificationRequest().providerOptions).toEqual({ acme: { mode: 'widget' } });
  });

  it('merges classification options with structured-output options', () => {
    mockCreateProvider.mockReturnValue(
      providerStub({
        classificationProviderOptions: { openai: { reasoningEffort: 'none' } },
        structuredOutputOptions: { anthropic: { structuredOutputMode: 'jsonTool' } },
      }),
    );

    expect(getClassificationRequest().providerOptions).toEqual({
      openai: { reasoningEffort: 'none' },
      anthropic: { structuredOutputMode: 'jsonTool' },
    });
  });

  it('merges one namespace deep — same-vendor fragments combine instead of clobbering', () => {
    mockCreateProvider.mockReturnValue(
      providerStub({
        classificationProviderOptions: { acme: { effort: 'none' } },
        structuredOutputOptions: { acme: { mode: 'widget' } },
      }),
    );

    expect(getClassificationRequest().providerOptions).toEqual({
      acme: { effort: 'none', mode: 'widget' },
    });
  });

  it('carries the same sampling-params contract as getGateRequest', () => {
    mockCreateProvider.mockReturnValue(providerStub());
    expect(getClassificationRequest().samplingParams).toEqual({ temperature: 0 });

    mockCreateProvider.mockReturnValue(providerStub({ classificationSamplingParams: {} }));
    expect(getClassificationRequest().samplingParams).toEqual({});
  });

  it('yields an empty bag when the provider declares none', () => {
    mockCreateProvider.mockReturnValue(providerStub());

    expect(getClassificationRequest().providerOptions).toEqual({});
  });

  it('builds the provider once — it is not a cheap accessor', () => {
    // Resolving the model and the options separately would run the AWS
    // credential chain and instantiate both SDK clients twice per classified
    // Slack message.
    mockCreateProvider.mockReturnValue(providerStub());

    getClassificationRequest();

    expect(mockCreateProvider).toHaveBeenCalledTimes(1);
  });
});

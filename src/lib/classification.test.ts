/**
 * Classification helpers — the seam between callers and vendor quirks.
 *
 * `getClassificationRequest()` exists so a caller like the Slack thread
 * classifier never names a vendor. These tests pin three things: the active
 * provider's options are passed through, a provider that declares none yields
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

import { getClassificationModel, getClassificationRequest } from './classification';

/** A provider stub: callable, with the attached members under test. */
function providerStub(structuredOutputOptions?: Record<string, Record<string, string>>) {
  return Object.assign(vi.fn((modelId: string) => ({ modelId })), {
    embedding: vi.fn(),
    ...(structuredOutputOptions ? { structuredOutputOptions } : {}),
  });
}

describe('getClassificationModel', () => {
  beforeEach(() => {
    config.classificationModelId = 'anthropic.claude-haiku-4-5';
  });

  it('resolves the configured classification model through the active provider', () => {
    const provider = providerStub();
    mockCreateProvider.mockReturnValue(provider);

    expect(getClassificationModel()).toEqual({ modelId: 'anthropic.claude-haiku-4-5' });
    expect(provider).toHaveBeenCalledWith('anthropic.claude-haiku-4-5');
  });
});

describe('getClassificationRequest', () => {
  beforeEach(() => {
    config.classificationModelId = 'anthropic.claude-haiku-4-5';
  });

  it("passes through the active provider's options, with the configured model", () => {
    mockCreateProvider.mockReturnValue(
      providerStub({ anthropic: { structuredOutputMode: 'jsonTool' } }),
    );

    expect(getClassificationRequest()).toEqual({
      model: { modelId: 'anthropic.claude-haiku-4-5' },
      providerOptions: { anthropic: { structuredOutputMode: 'jsonTool' } },
    });
  });

  it('is vendor-agnostic — whatever the provider declares is what comes back', () => {
    mockCreateProvider.mockReturnValue(providerStub({ acme: { mode: 'widget' } }));

    expect(getClassificationRequest().providerOptions).toEqual({ acme: { mode: 'widget' } });
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

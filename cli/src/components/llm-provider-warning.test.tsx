import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { LlmProviderWarning } from './llm-provider-warning.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LlmProviderWarning', () => {
  it('names the settings the provider needs', async () => {
    const api = {
      getLlmProvider: vi.fn().mockResolvedValue({
        provider: 'azure',
        missingSettings: ['AZURE_API_KEY', 'AZURE_RESOURCE_NAME'],
      }),
    };
    const { lastFrame } = render(<LlmProviderWarning api={api} />);
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No LLM provider is configured');
    expect(frame).toContain('Set AZURE_API_KEY and AZURE_RESOURCE_NAME for the azure');
  });

  it('shows nothing when the provider needs nothing', async () => {
    const api = { getLlmProvider: vi.fn().mockResolvedValue({ provider: 'bedrock', missingSettings: [] }) };
    const { lastFrame } = render(<LlmProviderWarning api={api} />);
    await flush();
    expect(lastFrame()).toBe('');
  });

  it('shows nothing when the runtime cannot answer', async () => {
    const api = { getLlmProvider: vi.fn().mockRejectedValue(new Error('404 Not Found')) };
    const { lastFrame } = render(<LlmProviderWarning api={api} />);
    await flush();
    expect(lastFrame()).toBe('');
  });
});

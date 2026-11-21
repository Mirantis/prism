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
    // Ink renders the answer a frame later, which a loaded runner can delay past one tick.
    await vi.waitFor(() => expect(lastFrame()).toContain('Connect a model provider'));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Required for azure');
    expect(frame).toContain('AZURE_API_KEY');
    expect(frame).toContain('AZURE_RESOURCE_NAME');
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

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LlmProviderBanner } from './llm-provider-banner';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { getLlmProvider: vi.fn(), updateStatus: vi.fn() },
}));

vi.mock('@/api/runtime-client', () => ({ runtimeApi: mockApi }));
vi.mock('@/lib/agent-context', () => ({ useAgent: () => ({ agentId: 'agent-1' }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LlmProviderBanner />
    </QueryClientProvider>,
  );
}

describe('LlmProviderBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.updateStatus.mockResolvedValue({ currentVersion: '' });
  });

  afterEach(() => {
    cleanup();
  });

  it('offers a copy button for every variable an entry names', async () => {
    mockApi.getLlmProvider.mockResolvedValue({
      provider: 'azure',
      missingSettings: ['AZURE_API_KEY', 'AZURE_RESOURCE_NAME (or AZURE_FOUNDRY_BASE_URL)'],
    });
    renderBanner();

    expect(await screen.findByRole('region', { name: 'Connect a model provider' })).toBeTruthy();
    for (const name of ['AZURE_API_KEY', 'AZURE_RESOURCE_NAME', 'AZURE_FOUNDRY_BASE_URL']) {
      expect(screen.getByRole('button', { name: `Copy ${name}` })).toBeTruthy();
    }
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText(/Restart Prism after editing environment variables/)).toBeTruthy();
  });

  it('links a step that is not a variable to Profile, with no restart advice', async () => {
    mockApi.getLlmProvider.mockResolvedValue({ provider: 'chatgpt', missingSettings: ['ChatGPT sign-in'] });
    renderBanner();

    expect((await screen.findByRole('link', { name: 'Open Profile' })).getAttribute('href')).toBe('/profile');
    expect(screen.queryByRole('button', { name: /^Copy / })).toBeNull();
    expect(screen.queryByText(/Restart Prism/)).toBeNull();
  });

  it('opens the setup guide of the running release', async () => {
    mockApi.updateStatus.mockResolvedValue({ currentVersion: 'v2026.11.19151733' });
    mockApi.getLlmProvider.mockResolvedValue({ provider: 'openai', missingSettings: ['OPENAI_API_KEY'] });
    renderBanner();

    const guide = await screen.findByRole('link', { name: 'Provider setup guide' });
    await vi.waitFor(() =>
      expect(guide.getAttribute('href')).toBe(
        'https://github.com/Mirantis/prism/blob/v2026.11.19151733/docs/configuration.md#provider-selection',
      ),
    );
  });
});

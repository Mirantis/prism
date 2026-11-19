// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatGptAuthCard } from './chatgpt-auth-card';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    chatGptAuthStatus: vi.fn(),
    startChatGptSignIn: vi.fn(),
    signOutChatGpt: vi.fn(),
  },
}));

vi.mock('@/api/runtime-client', () => ({
  runtimeApi: mockApi,
}));

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatGptAuthCard />
    </QueryClientProvider>,
  );
}

describe('ChatGptAuthCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when LLM_PROVIDER is not chatgpt', async () => {
    mockApi.chatGptAuthStatus.mockResolvedValue({
      enabled: false,
      signedIn: false,
      email: null,
      expiresAt: null,
    });
    const { container } = renderCard();
    await waitFor(() => expect(mockApi.chatGptAuthStatus).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('opens the authorize URL when clicking Sign in with ChatGPT', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    mockApi.chatGptAuthStatus.mockResolvedValue({
      enabled: true,
      signedIn: false,
      email: null,
      expiresAt: null,
    });
    mockApi.startChatGptSignIn.mockResolvedValue({
      authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=xyz',
      state: 'xyz',
    });

    renderCard();
    const btn = await screen.findByRole('button', { name: /Sign in with ChatGPT/i });
    fireEvent.click(btn);

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        'https://auth.openai.com/api/accounts/authorize?state=xyz',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    openSpy.mockRestore();
  });

  it('shows the signed-in email and signs out when requested', async () => {
    mockApi.chatGptAuthStatus.mockResolvedValue({
      enabled: true,
      signedIn: true,
      email: 'user@example.com',
      expiresAt: Date.now() + 3600_000,
    });
    mockApi.signOutChatGpt.mockResolvedValue({
      enabled: true,
      signedIn: false,
      email: null,
      expiresAt: null,
    });

    renderCard();
    expect(await screen.findByText('user@example.com')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sign out/i }));

    await waitFor(() => expect(mockApi.signOutChatGpt).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: /Sign in with ChatGPT/i })).toBeTruthy();
  });
});

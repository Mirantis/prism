// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockSlackWorkspaces, mockSlackChannelMappings, mockSlackLinkStatus } = vi.hoisted(() => ({
  mockSlackWorkspaces: vi.fn(),
  mockSlackChannelMappings: vi.fn(),
  mockSlackLinkStatus: vi.fn(),
}));

vi.mock('@/api/runtime-client', () => ({
  runtimeApi: {
    slackWorkspaces: mockSlackWorkspaces,
    slackChannelMappings: mockSlackChannelMappings,
    slackLinkStatus: mockSlackLinkStatus,
  },
}));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1', userId: 'user-1', name: 'Test Agent' }),
}));

import { useSlackChannels } from './use-slack-channels';
import { useSlackStatus } from './use-slack-status';

describe('useSlackStatus', () => {
  it('counts no channels while Slack is not connected, though the Webhooks form cached some', async () => {
    mockSlackWorkspaces.mockResolvedValue({ workspaces: [] });
    mockSlackChannelMappings.mockResolvedValue({
      channels: [
        { id: 'm-1', channelId: 'C_REL', channelName: 'release-notes', agentName: 'Prism', linkedAt: '', isMain: true },
      ],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    const picker = renderHook(() => useSlackChannels(), { wrapper });
    await waitFor(() => expect(picker.result.current.data?.channels).toHaveLength(1));

    const status = renderHook(() => useSlackStatus(), { wrapper });
    await waitFor(() => expect(status.result.current.isLoading).toBe(false));
    expect(status.result.current.workspace).toBeUndefined();
    expect(status.result.current.channelCount).toBe(0);
    expect(status.result.current.isLinked).toBe(false);
  });
});

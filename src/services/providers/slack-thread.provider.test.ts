/**
 * SlackThreadProvider — waitForExternalMessage
 *
 * Covers the eventual-consistency wait: poll conversations.replies until the
 * just-posted message appears, with a bounded budget.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma, mockGetSlackConnection, mockGetAppForTeam, mockReplies } = vi.hoisted(() => ({
  mockPrisma: {
    conversationThread: { findUnique: vi.fn() },
    slackMapping: { findFirst: vi.fn() },
    conversationMessage: { findMany: vi.fn() },
  },
  mockGetSlackConnection: vi.fn(),
  mockGetAppForTeam: vi.fn(),
  mockReplies: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({ default: mockPrisma }));
vi.mock('../../lib/slack-source', () => ({ getSlackConnection: mockGetSlackConnection }));
vi.mock('../slack-adapter.service', () => ({
  slackAdapterService: { getAppForTeam: mockGetAppForTeam },
}));

import { SlackThreadProvider } from './slack-thread.provider';

const reply = (ts: string) => ({ ts, user: 'U1', text: 'hi' });

describe('SlackThreadProvider.waitForExternalMessage', () => {
  let provider: SlackThreadProvider;

  beforeEach(() => {
    provider = new SlackThreadProvider();
    mockPrisma.conversationThread.findUnique.mockResolvedValue({
      externalChannelId: 'C1',
      externalThreadId: '100.1',
    });
    mockPrisma.slackMapping.findFirst.mockResolvedValue({ connectionId: 'conn1' });
    mockGetSlackConnection.mockResolvedValue({ teamId: 'T1', botUserId: 'B1' });
    mockGetAppForTeam.mockReturnValue({
      app: { client: { conversations: { replies: mockReplies } } },
    });
  });

  it('resolves immediately when the message is already present, using a targeted windowed read', async () => {
    mockReplies.mockResolvedValue({ messages: [reply('100.1'), reply('100.2')] });

    await expect(
      provider.waitForExternalMessage('thread-1', '100.2', {
        sleep: vi.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBeUndefined();
    expect(mockReplies).toHaveBeenCalledTimes(1);
    // Windowed to ts >= externalTs (the newest message) — no full-thread scan.
    expect(mockReplies).toHaveBeenCalledWith(
      expect.objectContaining({ oldest: '100.2', inclusive: true }),
    );
  });

  it('polls until an eventually-consistent message appears, then resolves', async () => {
    // First read is stale (missing 100.2); second read includes it.
    mockReplies
      .mockResolvedValueOnce({ messages: [reply('100.1')] })
      .mockResolvedValue({ messages: [reply('100.1'), reply('100.2')] });

    await expect(
      provider.waitForExternalMessage('thread-1', '100.2', {
        sleep: vi.fn().mockResolvedValue(undefined),
        baseDelayMs: 1,
      }),
    ).resolves.toBeUndefined();
    expect(mockReplies).toHaveBeenCalledTimes(2);
  });

  it('throws when the message never appears within the budget (does not proceed)', async () => {
    mockReplies.mockResolvedValue({ messages: [reply('100.1')] });
    let clock = 0;

    await expect(
      provider.waitForExternalMessage('thread-1', '999.9', {
        sleep: async (ms) => { clock += ms; },
        now: () => clock,
        baseDelayMs: 100,
        maxDelayMs: 200,
        timeoutMs: 500,
      }),
    ).rejects.toThrow(/999\.9/);
  });

  it('resolves the workspace mapping by slackChannelId OR dmChannelId (so threaded DMs resolve)', async () => {
    mockReplies.mockResolvedValue({ messages: [reply('100.1'), reply('100.2')] });

    await provider.waitForExternalMessage('thread-1', '100.2', {
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    // DM channels are stored on dmChannelId, not slackChannelId — the lookup
    // must match either so threaded-DM reads can resolve their workspace.
    expect(mockPrisma.slackMapping.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { slackChannelId: 'C1' },
            { dmChannelId: 'C1' },
          ]),
        }),
      }),
    );
  });

  it('does not poll when the thread is not a resolvable Slack thread', async () => {
    mockPrisma.conversationThread.findUnique.mockResolvedValue({
      externalChannelId: null,
      externalThreadId: null,
    });

    await expect(provider.waitForExternalMessage('thread-1', '100.2')).resolves.toBeUndefined();
    expect(mockReplies).not.toHaveBeenCalled();
  });
});

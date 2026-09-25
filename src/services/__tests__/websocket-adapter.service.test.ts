import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBroadcast, mockHasConnections } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
  mockHasConnections: vi.fn(),
}));

vi.mock('../websocket-gateway.service', () => ({
  webSocketGatewayService: { broadcast: mockBroadcast, hasConnections: mockHasConnections },
}));

import { webSocketAdapterService } from '../websocket-adapter.service';

const message = {
  id: 'msg-1',
  threadId: 'thread-1',
  role: 'USER' as const,
  content: 'Hello',
  triggeredBy: 'USER_INPUT' as const,
  toolCalls: null,
  blocks: null,
  senderExternalId: null,
  senderName: null,
  isCompacted: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

describe('webSocketAdapterService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delivers to every connection, not only the sender\'s user', async () => {
    await webSocketAdapterService.deliver('user-alice', message, { channel: 'websocket', threadId: 'thread-1' });

    expect(mockBroadcast).toHaveBeenCalledWith(
      {
        type: 'chat',
        payload: expect.objectContaining({
          id: 'msg-1',
          threadId: 'thread-1',
          role: 'USER',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      },
      undefined,
    );
  });

  it('skips the connection a user message came from', async () => {
    await webSocketAdapterService.deliver('user-alice', message, {
      channel: 'websocket',
      threadId: 'thread-1',
      originConnectionId: 'conn-a',
    });

    expect(mockBroadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat' }), 'conn-a');
  });

  it('broadcasts user messages', () => {
    expect(webSocketAdapterService.broadcastsUserMessages).toBe(true);
  });

  it('counts a user as reachable while any connection is open', async () => {
    mockHasConnections.mockReturnValue(true);
    expect(await webSocketAdapterService.isUserConnected('user-without-a-socket')).toBe(true);
    mockHasConnections.mockReturnValue(false);
    expect(await webSocketAdapterService.isUserConnected('user-alice')).toBe(false);
  });
});

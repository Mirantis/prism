/**
 * Slack Adapter — Feedback Action Handler Tests
 *
 * Exercises handleFeedbackAction in isolation (no Bolt, no Socket Mode):
 * - resolves the ConversationMessage + thread via Prisma
 * - emits the telemetry event with null userId (no Lens identity for Slack clicker) and slack.user.id in properties
 * - chat.update swaps the actions block for an inline ack block
 * - after FEEDBACK_ACK_LINGER_MS, a second chat.update removes the ack block
 *   so the message returns to a clean state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockFindMessage,
  mockTrackEvent,
  mockChatUpdate,
} = vi.hoisted(() => ({
  mockFindMessage: vi.fn(),
  mockTrackEvent: vi.fn(),
  mockChatUpdate: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  default: {
    conversationMessage: {
      findFirst: mockFindMessage,
    },
  },
}));

vi.mock('../../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

// Minimal logger stub so initialization doesn't bark.
vi.mock('../../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { slackAdapterService, FEEDBACK_ACK_LINGER_MS } from '../slack-adapter.service';
import {
  FEEDBACK_ACTION_UP,
  FEEDBACK_ACTION_DOWN,
  FEEDBACK_BLOCK_ID,
  FEEDBACK_ACK_BLOCK_ID,
  FEEDBACK_RATING_UP,
  FEEDBACK_RATING_DOWN,
  FeedbackRating,
} from '../../utils/slack-formatter';

const makeBody = (overrides: Record<string, unknown> = {}) => ({
  user: { id: 'U_CLICKER' },
  channel: { id: 'C_ROOM' },
  team: { id: 'T_TEAM' },
  message: {
    ts: '1700000000.000100',
    text: 'Original bot reply.',
    blocks: [
      { type: 'markdown', text: 'Original bot reply.' },
      {
        type: 'actions',
        block_id: FEEDBACK_BLOCK_ID,
        elements: [],
      },
    ],
  },
  actions: [
    { action_id: FEEDBACK_ACTION_UP, value: 'msg-42' },
  ],
  ...overrides,
});

const makeClient = () => ({
  chat: { update: mockChatUpdate },
});

const invoke = (
  body: ReturnType<typeof makeBody>,
  rating: FeedbackRating = FEEDBACK_RATING_UP,
) => slackAdapterService.handleFeedbackAction(body, makeClient(), rating);

describe('SlackAdapter.handleFeedbackAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockFindMessage.mockResolvedValue({
      id: 'msg-42',
      threadId: 'thread-77',
      externalMessageId: '1700000000.000100',
      thread: { agentId: 'agent-99' },
    });
    mockChatUpdate.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits telemetry with null userId and slack.user.id in properties for a 👍 click', async () => {
    await invoke(makeBody());

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'message feedback',
      null,
      {
        'message.id': 'msg-42',
        'thread.id': 'thread-77',
        'agent.id': 'agent-99',
        'channel.type': 'slack',
        'feedback.rating': 'up',
        'feedback.source': 'slack_blockkit',
        'slack.user.id': 'U_CLICKER',
      },
    );
  });

  it('emits rating=down for the 👎 action id', async () => {
    const body = makeBody({
      actions: [{ action_id: FEEDBACK_ACTION_DOWN, value: 'msg-42' }],
    });

    await invoke(body, FEEDBACK_RATING_DOWN);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'message feedback',
      null,
      expect.objectContaining({
        'feedback.rating': 'down',
        'slack.user.id': 'U_CLICKER',
      }),
    );
  });

  it('swaps the actions block for an inline ack block via chat.update', async () => {
    await invoke(makeBody());

    expect(mockChatUpdate).toHaveBeenCalledTimes(1);
    const [args] = mockChatUpdate.mock.calls[0] as [{
      channel: string;
      ts: string;
      text?: string;
      blocks: Array<{ block_id?: string; type: string }>;
    }];

    expect(args.channel).toBe('C_ROOM');
    expect(args.ts).toBe('1700000000.000100');
    // text is intentionally omitted so Slack keeps the original notification
    // fallback — echoing a long agent reply back tripped msg_too_long in prod.
    expect(args.text).toBeUndefined();

    // Actions block is gone.
    expect(args.blocks.some((b) => b.block_id === FEEDBACK_BLOCK_ID)).toBe(false);
    // Ack block is appended last.
    const last = args.blocks[args.blocks.length - 1];
    expect(last.type).toBe('context');
    expect(last.block_id).toBe(FEEDBACK_ACK_BLOCK_ID);
  });

  it('schedules a second chat.update after FEEDBACK_ACK_LINGER_MS to remove the ack block', async () => {
    await invoke(makeBody());

    // Immediate first update.
    expect(mockChatUpdate).toHaveBeenCalledTimes(1);

    // Advance the fake timer and flush the microtask queue so the async
    // cleanup body runs.
    await vi.advanceTimersByTimeAsync(FEEDBACK_ACK_LINGER_MS);

    expect(mockChatUpdate).toHaveBeenCalledTimes(2);
    const [second] = mockChatUpdate.mock.calls[1] as [{
      channel: string;
      ts: string;
      blocks: Array<{ block_id?: string; type: string }>;
    }];
    expect(second.channel).toBe('C_ROOM');
    expect(second.ts).toBe('1700000000.000100');
    // No actions block, no ack block — just the original content.
    expect(second.blocks.some((b) => b.block_id === FEEDBACK_BLOCK_ID)).toBe(false);
    expect(second.blocks.some((b) => b.block_id === FEEDBACK_ACK_BLOCK_ID)).toBe(false);
  });

  it('still acks when the ConversationMessage lookup fails, but skips telemetry', async () => {
    mockFindMessage.mockResolvedValue(null);

    await invoke(makeBody());

    expect(mockTrackEvent).not.toHaveBeenCalled();
    // UI is still cleaned up so the user isn't left with dangling buttons.
    expect(mockChatUpdate).toHaveBeenCalledTimes(1);
    // Cleanup still scheduled.
    await vi.advanceTimersByTimeAsync(FEEDBACK_ACK_LINGER_MS);
    expect(mockChatUpdate).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the payload is missing required fields', async () => {
    const bad = makeBody({ actions: undefined });
    await invoke(bad);

    expect(mockFindMessage).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockChatUpdate).not.toHaveBeenCalled();
  });
});

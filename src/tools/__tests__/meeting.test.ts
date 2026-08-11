/**
 * Meeting tool registration, gating, and the `meeting` tool mode.
 *
 * The mode filter matters more than it looks: it decides what a stranger on a
 * conference line can reach through the agent's voice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';

const mockJoin = vi.fn();
const mockLeave = vi.fn();
const mockStatus = vi.fn();
const mockFindProvider = vi.fn();

vi.mock('../../services/meeting/meeting-bot.service', () => ({
  meetingBotService: {
    join: (...args: unknown[]) => mockJoin(...args),
    leave: () => mockLeave(),
    status: () => mockStatus(),
    findProvider: (url: string) => mockFindProvider(url),
  },
}));

const mockIsBrowserAvailable = vi.fn();
vi.mock('../../services/meeting/browser-stack', () => ({
  isBrowserAvailable: () => mockIsBrowserAvailable(),
}));

const mockIsRealtimeConfigured = vi.fn();
vi.mock('../../services/meeting/openai-endpoint', () => ({
  isRealtimeConfigured: () => mockIsRealtimeConfigured(),
}));

const { getMeetingTools, isMeetingSupported, MEETING_TOOL_NAMES } = await import('../meeting');

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBrowserAvailable.mockResolvedValue(true);
  mockIsRealtimeConfigured.mockReturnValue(true);
  mockFindProvider.mockReturnValue({ name: 'google-meet', displayName: 'Google Meet' });
});

const input = { userId: 'u1', agentId: 'a1', threadId: 't1' };

describe('getMeetingTools', () => {
  it('names all three generically, and says which platforms work in the description', () => {
    // The platform comes from the URL, not the tool name — a per-platform *leave*
    // would mean two tools doing the identical thing to one single-call state.
    expect(Object.keys(getMeetingTools(input))).toEqual([
      'join_meeting',
      'leave_meeting',
      'meeting_status',
    ]);
    expect([...MEETING_TOOL_NAMES]).toEqual(Object.keys(getMeetingTools(input)));

    // The name no longer says "Google Meet", so the description has to.
    const { description } = getMeetingTools(input).join_meeting as { description: string };
    expect(description).toMatch(/Google Meet/);
  });

  it('passes the calling thread through so progress lands in the right place', async () => {
    mockJoin.mockResolvedValue({ state: 'waiting_admission', message: 'Requested to join.' });
    const tools = getMeetingTools(input);

    await tools.join_meeting.execute!(
      { url: 'https://meet.google.com/abc-defg-hij' },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    );

    expect(mockJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://meet.google.com/abc-defg-hij',
        userId: 'u1',
        agentId: 'a1',
        threadId: 't1',
      }),
    );
  });

  it('rejects a non-Meet link with an example instead of trying to join', async () => {
    mockFindProvider.mockReturnValue(null);
    const tools = getMeetingTools(input);

    const result = (await tools.join_meeting.execute!(
      { url: 'https://zoom.us/j/123' },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    )) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('meet.google.com');
    expect(mockJoin).not.toHaveBeenCalled();
  });

  it('forwards the response mode', async () => {
    mockJoin.mockResolvedValue({ state: 'waiting_admission', message: 'ok' });
    const tools = getMeetingTools(input);

    await tools.join_meeting.execute!(
      {
        url: 'https://meet.google.com/abc-defg-hij',
        responseMode: 'addressed',
        displayName: 'Prism Bot',
      },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    );

    expect(mockJoin).toHaveBeenCalledWith(
      expect.objectContaining({
        responseMode: 'addressed',
        displayName: 'Prism Bot',
      }),
    );
  });

  it('reports a failed join as unsuccessful', async () => {
    mockJoin.mockResolvedValue({ state: 'idle', message: 'Could not join the meeting: no chromium' });
    const tools = getMeetingTools(input);

    const result = (await tools.join_meeting.execute!(
      { url: 'https://meet.google.com/abc-defg-hij' },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    )) as { success: boolean };

    expect(result.success).toBe(false);
  });

  it('leaves and reports status', async () => {
    mockLeave.mockResolvedValue({ message: 'Left the Google Meet call.' });
    mockStatus.mockReturnValue({
      state: 'in_call',
      provider: 'google-meet',
      responseMode: 'auto',
      effectiveResponseMode: 'open',
      joinedAt: null,
    });
    const tools = getMeetingTools(input);
    const ctx = { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal };

    expect(await tools.leave_meeting.execute!({}, ctx)).toMatchObject({ success: true });
    expect(await tools.meeting_status.execute!({}, ctx)).toMatchObject({
      inMeeting: true,
      state: 'in_call',
      // What `auto` resolved to is what tells the agent whether it will be
      // prompted to speak; the requested mode alone does not.
      effectiveResponseMode: 'open',
    });
  });

  it('reports not being in a meeting', async () => {
    mockStatus.mockReturnValue({
      state: 'idle',
      provider: null,
      responseMode: 'auto',
      effectiveResponseMode: null,
      joinedAt: null,
    });
    const tools = getMeetingTools(input);

    expect(
      await tools.meeting_status.execute!(
        {},
        { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
      ),
    ).toMatchObject({ inMeeting: false });
  });
});

describe('isMeetingSupported', () => {
  it('is false without an OpenAI key', async () => {
    mockIsRealtimeConfigured.mockReturnValue(false);
    expect(await isMeetingSupported()).toBe(false);
  });

  it('is false without a browser', async () => {
    mockIsBrowserAvailable.mockResolvedValue(false);
    expect(await isMeetingSupported()).toBe(false);
  });

  it('is false when the audio toolchain is not on PATH', async () => {
    // A dev machine has neither pulseaudio nor Xvfb; the tools must not appear.
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent-for-test';
    try {
      expect(await isMeetingSupported()).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('meeting tool mode', () => {
  const EVERYTHING = [
    'memory_search', 'memory_write', 'memory_delete',
    'shell_exec', 'shell_write_file', 'claude_code', 'shell_spawn',
    'schedule_task', 'list_scheduled_tasks', 'delete_scheduled_task',
    'create_goal', 'get_goal', 'share_file', 'skill',
    'leave_meeting', 'join_meeting', 'meeting_status',
    'rename_self', 'update_soul', 'update_memory', 'update_user_profile',
    'update_heartbeat_config', 'update_settings', 'update_vision', 'clear_bootstrap',
  ];

  it('withholds share_file, and only share_file', async () => {
    const { filterToolsByMode } = await import('../../lib/tool-collection');

    // Deliberately unrestricted apart from share_file: an agent that can only read
    // is little use in a working meeting, so `prompts/meeting-prompt.ts` is the
    // only guard on the destructive tools — asserted in meeting-prompt.test.ts.
    // share_file is different in kind: it is not withheld for safety but because
    // nothing in a meeting delivers what it stores, so it could only lie.
    const everything = Object.fromEntries(EVERYTHING.map((n) => [n, stub()]));

    const filtered = filterToolsByMode(everything, 'meeting');

    expect(Object.keys(filtered).sort()).toEqual(
      EVERYTHING.filter((n) => n !== 'share_file').sort(),
    );
  });

  it('otherwise tracks chat mode, so the two cannot drift apart', async () => {
    const { filterToolsByMode } = await import('../../lib/tool-collection');
    const all = Object.fromEntries(EVERYTHING.map((n) => [n, stub()]));

    const chatOnly = Object.keys(filterToolsByMode(all, 'chat'))
      .filter((n) => n !== 'share_file');

    expect(Object.keys(filterToolsByMode(all, 'meeting'))).toEqual(chatOnly);
  });

  it('still keeps the meeting tools out of autonomous modes', async () => {
    const { filterToolsByMode } = await import('../../lib/tool-collection');

    // An autonomous run dialling into a live call with people in it is never what
    // the operator asked for — only a person in a conversation invites the agent.
    for (const mode of ['heartbeat', 'cron', 'webhook', 'subagent', 'goal']) {
      const filtered = filterToolsByMode(
        { join_meeting: stub(), leave_meeting: stub(), meeting_status: stub(), memory_search: stub() },
        mode,
      );
      expect(Object.keys(filtered)).toEqual(['memory_search']);
    }
  });
});

function stub() {
  return tool({ description: 'x', inputSchema: z.object({}), execute: async () => 'ok' });
}

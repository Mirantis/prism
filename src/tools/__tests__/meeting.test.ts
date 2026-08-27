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
const mockSpeakerReport = vi.fn();
const mockFindProvider = vi.fn();
const mockSendChatMessage = vi.fn();

vi.mock('../../services/meeting/meeting-bot.service', () => ({
  meetingBotService: {
    join: (...args: unknown[]) => mockJoin(...args),
    leave: () => mockLeave(),
    status: () => mockStatus(),
    speakerReport: () => mockSpeakerReport(),
    findProvider: (url: string) => mockFindProvider(url),
    sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
  },
  // Mirrors the real constant, which the service's own tests pin. Here it only has to
  // be the number the tool description quotes.
  MEETING_CHAT_MAX_CHARS: 500,
}));

const mockIsBrowserAvailable = vi.fn();
vi.mock('../../services/meeting/browser-stack', () => ({
  isBrowserAvailable: () => mockIsBrowserAvailable(),
}));

const mockIsRealtimeConfigured = vi.fn();
vi.mock('../../services/meeting/openai-endpoint', () => ({
  isRealtimeConfigured: () => mockIsRealtimeConfigured(),
}));

const { getMeetingTools, isMeetingSupported, MEETING_TOOL_NAMES, MEETING_ONLY_TOOL_NAMES } =
  await import('../meeting');

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBrowserAvailable.mockResolvedValue(true);
  mockIsRealtimeConfigured.mockReturnValue(true);
  mockFindProvider.mockReturnValue({ name: 'google-meet', displayName: 'Google Meet' });
  mockSendChatMessage.mockResolvedValue({ sent: true, message: `Posted it in the call's chat.` });
});

const input = { userId: 'u1', agentId: 'a1', threadId: 't1' };

describe('getMeetingTools', () => {
  it('names them all generically, and says which platforms work in the description', () => {
    // The platform comes from the URL, not the tool name — a per-platform *leave*
    // would mean two tools doing the identical thing to one single-call state.
    expect(Object.keys(getMeetingTools(input))).toEqual([
      'join_meeting',
      'leave_meeting',
      'meeting_speaker',
      'send_meeting_chat',
      'meeting_status',
    ]);
    expect([...MEETING_TOOL_NAMES].sort()).toEqual(Object.keys(getMeetingTools(input)).sort());

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
      },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    );

    expect(mockJoin).toHaveBeenCalledWith(
      expect.objectContaining({ responseMode: 'addressed' }),
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

  it('reports who spoke, and says so plainly when it cannot tell', async () => {
    const tools = getMeetingTools(input);
    const ctx = { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal };

    mockSpeakerReport.mockReturnValue({
      inMeeting: true,
      speakingNow: null,
      spokeToYou: { kind: 'person', name: 'Mario Sarcher' },
      roster: ['Mario Sarcher'],
      attribution: 'available',
      note: 'That was Mario Sarcher.',
    });
    expect(await tools.meeting_speaker.execute!({}, ctx)).toMatchObject({
      success: true,
      spokeToYou: { kind: 'person', name: 'Mario Sarcher' },
    });

    // The honest answer matters more than the confident one: a name read out to the wrong
    // person is worse than an admission, so `unavailable` has to survive to the model.
    mockSpeakerReport.mockReturnValue({
      inMeeting: true,
      speakingNow: null,
      spokeToYou: null,
      roster: [],
      attribution: 'unavailable',
      note: 'I cannot tell who is speaking in this call.',
    });
    expect(await tools.meeting_speaker.execute!({}, ctx)).toMatchObject({
      attribution: 'unavailable',
      spokeToYou: null,
    });
  });

  it('posts a chat message as the calling user, and says the cap in the description', async () => {
    const tools = getMeetingTools(input);
    const ctx = { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal };

    const result = await tools.send_meeting_chat.execute!(
      { text: 'https://example.test/run/42' },
      ctx,
    );

    expect(mockSendChatMessage).toHaveBeenCalledWith('https://example.test/run/42', 'u1');
    expect(result).toMatchObject({ success: true });
    // The model has no other way to know how long is too long, and the alternative is
    // a refusal it could have avoided.
    const { description } = tools.send_meeting_chat as { description: string };
    expect(description).toContain('500');
    // And it is told what to do instead, since speech is the channel that always works.
    expect(description).toMatch(/out loud/);
  });

  it('reports a refused or failed send as unsuccessful', async () => {
    // The model acts on `success`; a refusal reported as a success is a message the
    // agent believes the room can read.
    mockSendChatMessage.mockResolvedValue({ sent: false, message: `I'm not in a call.` });
    const tools = getMeetingTools(input);

    const result = (await tools.send_meeting_chat.execute!(
      { text: 'anyone there?' },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    )) as { success: boolean; message: string };

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not in a call/);
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
    'leave_meeting', 'join_meeting', 'meeting_status', 'meeting_speaker',
    'send_meeting_chat',
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
    // Not equality any more, and the difference is the point: chat drops the in-call
    // tools because a chat turn stores its tool calls as conversation history, and a
    // message posted into a call must not be written down anywhere.
    const { filterToolsByMode } = await import('../../lib/tool-collection');
    const all = Object.fromEntries(EVERYTHING.map((n) => [n, stub()]));

    const expected = [
      ...Object.keys(filterToolsByMode(all, 'chat')).filter((n) => n !== 'share_file'),
      ...MEETING_ONLY_TOOL_NAMES,
    ].sort();

    expect(Object.keys(filterToolsByMode(all, 'meeting')).sort()).toEqual(expected);
  });

  it('keeps the in-call tools out of chat, and the rest in', async () => {
    // Asking "am I in a call?" from chat is reasonable, and joining one from chat is how
    // a call starts. Only the send is withheld, and only because of what chat persists.
    const { filterToolsByMode } = await import('../../lib/tool-collection');
    const all = Object.fromEntries(EVERYTHING.map((n) => [n, stub()]));

    const chat = Object.keys(filterToolsByMode(all, 'chat'));

    expect(chat).not.toContain('send_meeting_chat');
    expect(chat).toContain('join_meeting');
    expect(chat).toContain('leave_meeting');
    expect(chat).toContain('meeting_status');
    expect(chat).toContain('share_file');
  });

  it('still keeps the meeting tools out of autonomous modes', async () => {
    const { filterToolsByMode } = await import('../../lib/tool-collection');

    // An autonomous run dialling into a live call with people in it is never what
    // the operator asked for — only a person in a conversation invites the agent.
    for (const mode of ['heartbeat', 'cron', 'webhook', 'subagent', 'goal']) {
      const filtered = filterToolsByMode(
        {
          join_meeting: stub(),
          leave_meeting: stub(),
          meeting_status: stub(),
          send_meeting_chat: stub(),
          memory_search: stub(),
        },
        mode,
      );
      expect(Object.keys(filtered)).toEqual(['memory_search']);
    }
  });
});

function stub() {
  return tool({ description: 'x', inputSchema: z.object({}), execute: async () => 'ok' });
}

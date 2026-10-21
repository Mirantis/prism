/**
 * Meeting tool registration, gating, and the `meeting` tool mode.
 *
 * The mode filter matters more than it looks: it decides what a stranger on a
 * conference line can reach through the agent's voice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
// Imported once here: a cold import of the tool graph takes seconds, which inside a test
// body counts against that test's timeout.
import { filterToolsByMode } from '../../lib/tool-collection';

const mockJoin = vi.fn();
const mockLeave = vi.fn();
const mockStatus = vi.fn();
const mockSpeakerReport = vi.fn();
const mockFindProvider = vi.fn();
const mockSendChatMessage = vi.fn();
const mockReadChatMessages = vi.fn();

vi.mock('../../services/meeting/meeting-bot.service', () => ({
  meetingBotService: {
    join: (...args: unknown[]) => mockJoin(...args),
    leave: () => mockLeave(),
    status: () => mockStatus(),
    speakerReport: () => mockSpeakerReport(),
    findProvider: (url: string) => mockFindProvider(url),
    sendChatMessage: (...args: unknown[]) => mockSendChatMessage(...args),
    readChatMessages: (...args: unknown[]) => mockReadChatMessages(...args),
  },
  // Mirror the real constants, which the service's own tests pin. Here they only have to
  // be the numbers the tool descriptions quote.
  MEETING_CHAT_MAX_CHARS: 500,
  MEETING_CHAT_READ_LIMIT: 20,
  MEETING_CHAT_CUT_MARK: ' [message cut]',
}));

const mockIsBrowserAvailable = vi.fn();
vi.mock('../../services/meeting/browser-stack', () => ({
  isBrowserAvailable: () => mockIsBrowserAvailable(),
}));

const mockIsRealtimeConfigured = vi.fn();
vi.mock('../../services/meeting/openai-endpoint', () => ({
  isRealtimeConfigured: () => mockIsRealtimeConfigured(),
}));

const {
  getMeetingTools,
  isMeetingSupported,
  MEETING_MEMBERSHIP_TOOL_NAMES,
  MEETING_READ_TOOL_NAME,
} = await import('../meeting');

beforeEach(() => {
  vi.clearAllMocks();
  mockIsBrowserAvailable.mockResolvedValue(true);
  mockIsRealtimeConfigured.mockReturnValue(true);
  mockFindProvider.mockReturnValue({ name: 'google-meet', displayName: 'Google Meet' });
  mockSendChatMessage.mockResolvedValue({ sent: true, message: `Posted it in the call's chat.` });
  mockReadChatMessages.mockResolvedValue({
    success: true,
    message: '<chat>\n1. hello\n</chat>',
    incomplete: false,
  });
});

const input = { userId: 'u1', agentId: 'a1', threadId: 't1' };

describe('getMeetingTools', () => {
  it('names them all generically, and says which platforms work in the description', () => {
    // The platform comes from the URL, not the tool name — a per-platform *leave*
    // would mean two tools doing the identical thing to one single-call state.
    expect(Object.keys(getMeetingTools(input))).toEqual([
      'join_meeting',
      'leave_meeting',
      'set_microphone',
      'share_screen',
      'stop_screen_share',
      'browse',
      'see_screen',
      'meeting_speaker',
      'send_meeting_chat',
      'read_meeting_chat',
      'meeting_status',
    ]);
    // Every name the mode filter acts on has to be one of the names registered here, or it
    // withholds nothing.
    for (const name of [...MEETING_MEMBERSHIP_TOOL_NAMES, MEETING_READ_TOOL_NAME]) {
      expect(Object.keys(getMeetingTools(input))).toContain(name);
    }

    // The name no longer says "Google Meet", so the description has to.
    const { description } = getMeetingTools(input).join_meeting as { description: string };
    expect(description).toMatch(/Google Meet/);
  });

  it('tells the model what sharing a screen is for, in the operator\'s words', () => {
    // Sharing has two uses a model will not infer from "share your screen": showing a
    // page, and walking a room through an application. Pinned verbatim, because it is
    // the sentence the operator asked for.
    const { description } = getMeetingTools(input).share_screen as { description: string };
    expect(description).toContain(
      'Use this tool to show something in the browser or demonstrate UI features of an application.',
    );
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

  it('hands the failing step to the model', async () => {
    // Which part failed decides what the agent does next: a dead link is worth saying
    // out loud, and a container with no microphone is worth nothing but a report.
    mockJoin.mockResolvedValue({
      state: 'idle',
      step: 'page_load',
      message: 'Could not join the meeting: net::ERR_TUNNEL_CONNECTION_FAILED',
    });
    const tools = getMeetingTools(input);

    const result = (await tools.join_meeting.execute!(
      { url: 'https://meet.google.com/abc-defg-hij' },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    )) as { success: boolean; step?: string };

    expect(result.success).toBe(false);
    expect(result.step).toBe('page_load');
  });

  it('omits the step for a join that got as far as asking', async () => {
    // The optimistic answer carries none, and an absent step is how the model tells
    // "it never asked" from "nobody has answered yet".
    mockJoin.mockResolvedValue({
      state: 'waiting_admission',
      message: 'Requested to join the Google Meet call.',
    });
    const tools = getMeetingTools(input);

    const result = (await tools.join_meeting.execute!(
      { url: 'https://meet.google.com/abc-defg-hij' },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    )) as { success: boolean; step?: string };

    expect(result.success).toBe(true);
    expect(result.step).toBeUndefined();
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
    mockSendChatMessage.mockResolvedValue({
      sent: false,
      message: `I'm not in a call, so there's no meeting chat to post into.`,
    });
    const tools = getMeetingTools(input);

    const result = (await tools.send_meeting_chat.execute!(
      { text: 'anyone there?' },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    )) as { success: boolean; message: string };

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not in a call/);
  });

  it('reads the chat as the calling user, and describes what a reading holds', async () => {
    const tools = getMeetingTools(input);

    const result = await tools.read_meeting_chat.execute!(
      {},
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    );

    expect(mockReadChatMessages).toHaveBeenCalledWith('u1');
    expect(result).toMatchObject({ success: true, incomplete: false });
    // The description is where the model learns what a reading holds before it asks for
    // one: the newest messages, each named with its sender, and a mark on a message the
    // reader cut short.
    const { description } = tools.read_meeting_chat as { description: string };
    expect(description).toMatch(/name the call shows for whoever sent it/i);
    expect(description).toContain('[message cut]');
    expect(description).toContain('20');
  });

  it('reports a refused read as unsuccessful', async () => {
    mockReadChatMessages.mockResolvedValue({
      success: false,
      message: `I'm not in a call, so there's no meeting chat to read.`,
      incomplete: false,
    });
    const tools = getMeetingTools(input);

    const result = (await tools.read_meeting_chat.execute!(
      {},
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
    'shell_exec', 'shell_write_file', 'coding_agent', 'shell_spawn',
    'schedule_task', 'list_scheduled_tasks', 'update_scheduled_task', 'delete_scheduled_task',
    'create_goal', 'get_goal', 'share_file', 'skill', 'web_fetch',
    'leave_meeting', 'join_meeting', 'set_microphone', 'meeting_status', 'meeting_speaker',
    'send_meeting_chat', 'read_meeting_chat',
    'rename_self', 'update_soul', 'update_memory', 'update_user_profile',
    'update_heartbeat_config', 'update_settings', 'update_vision', 'clear_bootstrap',
  ];

  it('withholds share_file, and only share_file', () => {
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

  it('is chat minus share_file plus the chat read, so the two cannot drift apart', () => {
    const all = Object.fromEntries(EVERYTHING.map((n) => [n, stub()]));

    const expected = [
      ...Object.keys(filterToolsByMode(all, 'chat')).filter((n) => n !== 'share_file'),
      'read_meeting_chat',
    ].sort();

    expect(Object.keys(filterToolsByMode(all, 'meeting')).sort()).toEqual(expected);
  });

  it('offers the whole meeting set in chat except the chat read', () => {
    // A chat turn can post into a call that is already running. It costs the line being
    // stored with the thread like any other tool argument, which two reviewers weighed
    // and accepted; `docs/tools.md` says so. Reading the chat is the one that cannot pay
    // that cost: the words are other people's, and a stored tool result is replayed into
    // every later turn.
    const all = Object.fromEntries(EVERYTHING.map((n) => [n, stub()]));

    expect(Object.keys(filterToolsByMode(all, 'chat')).sort()).toEqual(
      EVERYTHING.filter((n) => n !== 'read_meeting_chat').sort(),
    );
  });

  it('keeps joining, leaving and the chat read out of the autonomous modes', () => {
    // An autonomous run dialling into a live call with people in it, or hanging up on
    // one, is never what the operator asked for — only a person in a conversation
    // decides that. Posting one line into a call already running is the reverse: a
    // scheduled run that the room kicked off reports back into the room that way. Reading
    // the chat is out because these modes store their tool results.
    for (const mode of ['heartbeat', 'cron', 'webhook', 'subagent', 'goal']) {
      const filtered = filterToolsByMode(
        {
          join_meeting: stub(),
          leave_meeting: stub(),
          meeting_speaker: stub(),
          set_microphone: stub(),
          meeting_status: stub(),
          send_meeting_chat: stub(),
          read_meeting_chat: stub(),
          memory_search: stub(),
        },
        mode,
      );
      expect(Object.keys(filtered).sort()).toEqual(
        [
          'meeting_speaker',
          'meeting_status',
          'memory_search',
          'send_meeting_chat',
          'set_microphone',
        ].sort(),
      );
    }
  });

  it('keeps those three out of a mode nobody enumerated either', () => {
    // The fallback hands an unknown mode every other tool, which is the right default
    // for a caller this function has not heard of. It is the wrong default for the two
    // that change which call the agent is in, and for the read whose result that caller
    // would store.

    const filtered = filterToolsByMode(
      {
        join_meeting: stub(),
        leave_meeting: stub(),
        meeting_speaker: stub(),
        meeting_status: stub(),
        send_meeting_chat: stub(),
        read_meeting_chat: stub(),
        memory_search: stub(),
        shell_exec: stub(),
      },
      'a-mode-that-does-not-exist',
    );

    expect(Object.keys(filtered).sort()).toEqual(
      ['meeting_speaker', 'meeting_status', 'memory_search', 'send_meeting_chat', 'shell_exec'].sort(),
    );
  });
});

function stub() {
  return tool({ description: 'x', inputSchema: z.object({}), execute: async () => 'ok' });
}

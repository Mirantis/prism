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

const mockIsChromiumAvailable = vi.fn();
vi.mock('../../services/meeting/browser-stack', () => ({
  isChromiumAvailable: () => mockIsChromiumAvailable(),
}));

const mockIsRealtimeConfigured = vi.fn();
vi.mock('../../services/meeting/openai-endpoint', () => ({
  isRealtimeConfigured: () => mockIsRealtimeConfigured(),
}));

const { getMeetingTools, isMeetingSupported, MEETING_TOOL_NAMES } = await import('../meeting');

beforeEach(() => {
  vi.clearAllMocks();
  mockIsChromiumAvailable.mockResolvedValue(true);
  mockIsRealtimeConfigured.mockReturnValue(true);
  mockFindProvider.mockReturnValue({ name: 'google-meet', displayName: 'Google Meet' });
});

const input = { userId: 'u1', agentId: 'a1', threadId: 't1' };

describe('getMeetingTools', () => {
  it('names the join tool after the platform, keeping leave and status generic', () => {
    // A future Teams provider adds its own join tool and reuses these two.
    expect(Object.keys(getMeetingTools(input))).toEqual([
      'join_google_meet',
      'leave_meeting',
      'meeting_status',
    ]);
    expect([...MEETING_TOOL_NAMES]).toEqual(Object.keys(getMeetingTools(input)));
  });

  it('passes the calling thread through so progress lands in the right place', async () => {
    mockJoin.mockResolvedValue({ state: 'waiting_admission', message: 'Requested to join.' });
    const tools = getMeetingTools(input);

    await tools.join_google_meet.execute!(
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

    const result = (await tools.join_google_meet.execute!(
      { url: 'https://zoom.us/j/123' },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    )) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('meet.google.com');
    expect(mockJoin).not.toHaveBeenCalled();
  });

  it('forwards the addressedOnly option', async () => {
    mockJoin.mockResolvedValue({ state: 'waiting_admission', message: 'ok' });
    const tools = getMeetingTools(input);

    await tools.join_google_meet.execute!(
      { url: 'https://meet.google.com/abc-defg-hij', addressedOnly: true, displayName: 'Prism Bot' },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    );

    expect(mockJoin).toHaveBeenCalledWith(
      expect.objectContaining({ addressedOnly: true, displayName: 'Prism Bot' }),
    );
  });

  it('reports a failed join as unsuccessful', async () => {
    mockJoin.mockResolvedValue({ state: 'idle', message: 'Could not join the meeting: no chromium' });
    const tools = getMeetingTools(input);

    const result = (await tools.join_google_meet.execute!(
      { url: 'https://meet.google.com/abc-defg-hij' },
      { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal },
    )) as { success: boolean };

    expect(result.success).toBe(false);
  });

  it('leaves and reports status', async () => {
    mockLeave.mockResolvedValue({ message: 'Left the Google Meet call.' });
    mockStatus.mockReturnValue({ state: 'in_call', provider: 'google-meet', addressedOnly: false, joinedAt: null });
    const tools = getMeetingTools(input);
    const ctx = { toolCallId: 'c', messages: [], abortSignal: new AbortController().signal };

    expect(await tools.leave_meeting.execute!({}, ctx)).toMatchObject({ success: true });
    expect(await tools.meeting_status.execute!({}, ctx)).toMatchObject({
      inMeeting: true,
      state: 'in_call',
    });
  });

  it('reports not being in a meeting', async () => {
    mockStatus.mockReturnValue({ state: 'idle', provider: null, addressedOnly: false, joinedAt: null });
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
    mockIsChromiumAvailable.mockResolvedValue(false);
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
  it('drops what does not belong in a live call', async () => {
    const { filterToolsByMode } = await import('../../lib/tool-collection');

    const filtered = filterToolsByMode(
      {
        // Kept: reads and work the room can hear being done.
        memory_search: stub(),
        shell_exec: stub(),
        skill: stub(),
        // Kept: "please leave" is a reasonable thing to say out loud.
        leave_meeting: stub(),
        // Dropped: joining another call, or reporting on itself, mid-call.
        join_google_meet: stub(),
        meeting_status: stub(),
        // Dropped: minutes-long work that would leave the room in silence.
        claude_code: stub(),
        shell_spawn: stub(),
        shell_stdout: stub(),
        // Dropped: they target a user thread a meeting doesn't have.
        create_goal: stub(),
        share_file: stub(),
      },
      'meeting',
    );

    expect(Object.keys(filtered).sort()).toEqual(
      ['leave_meeting', 'memory_search', 'shell_exec', 'skill'].sort(),
    );
  });

  it('withholds everything that would outlive the call', async () => {
    const { filterToolsByMode } = await import('../../lib/tool-collection');
    const { AGENT_CONFIG_WRITE_TOOL_NAMES } = await import('../agent-config');

    const dangerous = [
      // A spoken request would become a persisted task that later runs in `cron`
      // mode with a wider toolset — an escalation around this very filter.
      'schedule_task',
      'list_scheduled_tasks',
      'delete_scheduled_task',
      // Persistent prompt injection: a sentence in a call would shape every
      // future turn, long after everyone hung up.
      'memory_write',
      'memory_delete',
      ...AGENT_CONFIG_WRITE_TOOL_NAMES,
    ];

    const filtered = filterToolsByMode(
      Object.fromEntries([...dangerous, 'memory_search'].map((n) => [n, stub()])),
      'meeting',
    );

    // Meeting audio is unauthenticated — this list is the boundary, not the prompt.
    expect(Object.keys(filtered)).toEqual(['memory_search']);
  });

  it('keeps the withheld agent-config list in step with the tools that exist', async () => {
    const { getAgentConfigTools, AGENT_CONFIG_WRITE_TOOL_NAMES } = await import('../agent-config');

    // A new self-modification tool must not quietly become reachable from a call.
    expect(Object.keys(getAgentConfigTools()).sort()).toEqual([...AGENT_CONFIG_WRITE_TOOL_NAMES].sort());
  });

  it('leaves the chat mode tool set untouched', async () => {
    const { filterToolsByMode } = await import('../../lib/tool-collection');
    const all = { join_google_meet: stub(), claude_code: stub(), create_goal: stub() };

    expect(Object.keys(filterToolsByMode(all, 'chat'))).toEqual(Object.keys(all));
  });

  it('keeps the meeting tools out of autonomous modes too', async () => {
    const { filterToolsByMode } = await import('../../lib/tool-collection');

    // An autonomous run dialling into a live call with people in it is never what
    // the operator asked for — only a person in a conversation invites the agent.
    for (const mode of ['heartbeat', 'cron', 'webhook', 'subagent', 'goal']) {
      const filtered = filterToolsByMode(
        { join_google_meet: stub(), leave_meeting: stub(), meeting_status: stub(), memory_search: stub() },
        mode,
      );
      expect(Object.keys(filtered)).toEqual(['memory_search']);
    }
  });
});

function stub() {
  return tool({ description: 'x', inputSchema: z.object({}), execute: async () => 'ok' });
}

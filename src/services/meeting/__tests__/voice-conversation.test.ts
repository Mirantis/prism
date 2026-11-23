/**
 * The seam between a dead Realtime session and the service that owns the call.
 *
 * Run against a real local WebSocket server rather than a mocked session, because
 * the distinction being tested — a close the server initiated versus one we asked
 * for — only exists at the socket level.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { VoiceConversation, type VoiceConversationOptions } from '../voice-conversation';
import { MEETING_SAMPLE_RATE, REALTIME_SAMPLE_RATE } from '../resampler';
import { currentSpendContext } from '../../../lib/spend-context';

vi.mock('../realtime-usage', () => ({ recordRealtimeUsage: vi.fn() }));

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Every `info` line emitted so far, joined — the latency figures live here. */
function infoLines(): string {
  return vi
    .mocked(logger.info)
    .mock.calls.map((c) => String(c[0]))
    .join('\n');
}

/**
 * Requests the conversation made for itself — the ones that put the agent's voice
 * in the room. A gate probe is also a `response.create`, but carries a `response`
 * body; the conversation's asks for nothing special.
 */
function spokenRequests(sent: Record<string, unknown>[]): Record<string, unknown>[] {
  return sent.filter((e) => e.type === 'response.create' && !e.response);
}

/** The gate probe on the wire, if one has been sent. */
function probeSent(sent: Record<string, unknown>[]): Record<string, any> | undefined {
  return sent.find((e) => e.type === 'response.create' && e.response) as
    | Record<string, any>
    | undefined;
}

beforeEach(() => {
  vi.mocked(logger.info).mockClear();
  vi.mocked(config).meetingTranscriptLogging = 'off';
});

interface Harness {
  conversation: VoiceConversation;
  /** Close the socket from the server's side, as OpenAI would on a drop. */
  dropFromServer: () => void;
  lost: string[];
  dispose: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  let socket: ServerSocket | null = null;
  const connected = new Promise<void>((resolve) => {
    server.once('connection', (ws) => {
      socket = ws;
      resolve();
    });
  });

  const lost: string[] = [];
  const conversation = new VoiceConversation({
    instructions: 'You are Prism.',
    tools: { declarations: [], count: 0, execute: vi.fn() },
    sink: { write: vi.fn() },
    agentName: 'Prism',
    sampleRate: MEETING_SAMPLE_RATE,
    endpointOverride: { url: `ws://127.0.0.1:${port}`, headers: {} },
    onSessionLost: (reason) => lost.push(reason),
    spend: { purpose: 'meeting', requestId: 'call-1' },
  });
  await conversation.start();
  await connected;

  return {
    conversation,
    lost,
    dropFromServer: () => socket?.close(1011, 'server gone'),
    dispose: async () => {
      conversation.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * A live socket that can push the events OpenAI would send and record what the
 * client sends back — `response.create` being the one that puts the agent's voice
 * in the room.
 */
async function speakingHarness(
  sampleRate: number = MEETING_SAMPLE_RATE,
  options: Partial<VoiceConversationOptions> = {},
): Promise<{
  h: Harness;
  send: (event: Record<string, unknown>) => void;
  sent: Record<string, unknown>[];
}> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;

  const sent: Record<string, unknown>[] = [];
  let socket: ServerSocket | null = null;
  const connected = new Promise<void>((resolve) => {
    server.once('connection', (ws) => {
      socket = ws;
      ws.on('message', (raw) => {
        try {
          sent.push(JSON.parse(String(raw)) as Record<string, unknown>);
        } catch {
          // Audio frames and anything else unparseable are not what is measured.
        }
      });
      resolve();
    });
  });

  const conversation = new VoiceConversation({
    instructions: 'You are Emma.',
    tools: { declarations: [], count: 0, execute: vi.fn() },
    sink: { write: vi.fn() },
    agentName: 'Emma',
    // Named, so every utterance goes to the gate rather than being answered outright.
    responseMode: 'addressed',
    sampleRate,
    endpointOverride: { url: `ws://127.0.0.1:${port}`, headers: {} },
    spend: { purpose: 'meeting', requestId: 'call-1' },
    ...options,
  });
  await conversation.start();
  await connected;

  return {
    h: {
      conversation,
      lost: [],
      dropFromServer: () => socket?.close(1011, 'server gone'),
      dispose: async () => {
        conversation.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    },
    send: (event) => socket?.send(JSON.stringify(event)),
    sent,
  };
}

/** Give the close frame a turn to land. */
const settle = () => new Promise((r) => setTimeout(r, 20));

let active: Harness | null = null;
afterEach(async () => {
  await active?.dispose();
  active = null;
});

describe('opening the session', () => {
  const OPENING = '\n\nContext:\n<recent-memories>\n- Paused the deploy (decision)\n</recent-memories>';

  it('sends the opening context once, as a user item after the configuration', async () => {
    const { h, sent } = await speakingHarness(MEETING_SAMPLE_RATE, { openingContext: OPENING });
    active = h;
    await settle();

    const types = sent.map((event) => event.type);
    expect(types.filter((type) => type === 'conversation.item.create')).toHaveLength(1);
    expect(types.indexOf('conversation.item.create')).toBeGreaterThan(types.indexOf('session.update'));
    expect(sent.find((event) => event.type === 'conversation.item.create')).toEqual({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: OPENING }] },
    });
  });

  it('sends no item when there is nothing to open with', async () => {
    const { h, sent } = await speakingHarness(MEETING_SAMPLE_RATE, { openingContext: null });
    active = h;
    await settle();

    expect(sent.some((event) => event.type === 'conversation.item.create')).toBe(false);
  });
});

describe('losing the Realtime session', () => {
  it('reports a close the server initiated', async () => {
    active = await harness();

    active.dropFromServer();
    await settle();

    // The owner needs to hear about this: the browser is still sitting in the
    // meeting, but nothing can be said or heard any more.
    expect(active.lost).toHaveLength(1);
    expect(active.lost[0]).toContain('server gone');
  });

  it('says nothing about a close it asked for itself', async () => {
    active = await harness();

    active.conversation.stop();
    await settle();

    expect(active.lost).toEqual([]);
  });

  it('reports a close only once', async () => {
    active = await harness();

    active.dropFromServer();
    await settle();
    // A teardown following the loss must not look like a second loss.
    active.conversation.stop();
    await settle();

    expect(active.lost).toHaveLength(1);
  });
});

describe('telling the session who is in the room', () => {
  it('hints the transcriber when the log will carry the words', async () => {
    vi.mocked(config).meetingTranscriptLogging = 'full';
    const { h, sent } = await speakingHarness();
    active = h;

    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);
    await settle();

    // The *last* one: the session is configured at connect with the agent's own
    // name already, so the first `session.update` is that one, not the roster.
    const updates = sent.filter((e) => e.type === 'session.update');
    const update = updates[updates.length - 1];
    const keywords = (
      update?.session as { audio?: { input?: { transcription?: { keywords?: string[] } } } }
    )?.audio?.input?.transcription?.keywords;
    // The agent's own name leads: it is the hardest word in the transcript and the
    // one a reader needs to be right.
    expect(keywords?.[0]).toBe('Emma');
    expect(keywords).toContain('Mario Sarcher');

    // Re-sending an unchanged roster would mutate a live session every poll.
    const before = sent.length;
    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);
    await settle();
    expect(sent.length).toBe(before);
  });

  it('sends no transcriber config at all when nothing will read it', async () => {
    // `off` by default, so this is the ordinary case: the roster poll must not
    // quietly switch transcription back on and start billing per minute.
    const { h, sent } = await speakingHarness();
    active = h;

    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher']);
    await settle();

    const updates = sent.filter((e) => e.type === 'session.update');
    expect(JSON.stringify(updates)).not.toContain('transcription');
  });

  it('tells the model who is in the room either way', async () => {
    const { h, sent } = await speakingHarness();
    active = h;

    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);
    await settle();

    // Independent of the transcript setting: the model cannot read the
    // transcriber's config, and "who is in this call?" is a question the room asks.
    const context = sent.filter((e) => e.type === 'conversation.item.create');
    expect(JSON.stringify(context)).toContain('Mario Sarcher');
    // ...and it is not told it is talking to itself.
    expect(JSON.stringify(context)).not.toContain('are now: Emma');
  });
});

describe('a roster read from a moving UI', () => {
  it('ignores a reordering of the same people', async () => {
    const { h, sent } = await speakingHarness();
    active = h;

    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);
    await settle();
    const before = sent.length;

    // Meet reorders tiles by who is speaking, so the same room arrives in a
    // different order every poll. Treated as a change, each one mutated the live
    // transcriber config and pushed another roster item into the model's context.
    h.conversation.setParticipantNames(['Lee', 'Emma', 'Mario Sarcher']);
    await settle();

    expect(sent.length).toBe(before);
  });

  it('does not tell the model it is alone when the scrape found only itself', async () => {
    const { h, sent } = await speakingHarness();
    active = h;

    // A grid that has not painted yet, or has virtualized everyone off-screen.
    // That is a failed read, not an empty room — and saying so mid-meeting is a
    // false statement the model may act on.
    h.conversation.setParticipantNames(['Emma']);
    await settle();

    expect(JSON.stringify(sent)).not.toContain('alone');
    expect(sent.filter((e) => e.type === 'conversation.item.create')).toHaveLength(0);
  });
});

/**
 * The whole decision, end to end over a real socket: the turn detector closes an
 * utterance, the gate is asked about that utterance, and the answer follows or
 * does not.
 */
describe('deciding whether to answer', () => {
  /** Answer the probe the client has sent, the way the server would. */
  async function answerGate(
    send: (event: Record<string, unknown>) => void,
    sent: Record<string, unknown>[],
    verdict: 'YES' | 'NO',
    responseId = 'r-gate',
  ): Promise<void> {
    const probe = probeSent(sent);
    if (!probe) throw new Error('the gate was never asked');
    send({
      type: 'response.created',
      response: { id: responseId, metadata: probe.response.metadata },
    });
    send({
      type: 'response.done',
      response: { id: responseId, status: 'completed', output: [{ content: [{ text: verdict }] }] },
    });
    await settle();
  }

  it('asks about the utterance that just closed, and answers when told to', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    await settle();

    // Judged from the audio, with a bounded slice of the call as context and the
    // utterance in question last. No transcript is involved.
    const probe = probeSent(sent)!;
    expect(probe.response.conversation).toBe('none');
    const referenced = (probe.response.input as Array<{ type: string; id: string }>).map((r) => r.id);
    expect(referenced.at(-1)).toBe('item-1');
    expect(referenced.length).toBeLessThanOrEqual(12);
    expect(spokenRequests(sent)).toHaveLength(0);

    await answerGate(send, sent, 'YES');

    expect(spokenRequests(sent)).toHaveLength(1);
  });

  it('stays quiet when the utterance was not for the agent', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-2' });
    await settle();
    await answerGate(send, sent, 'NO');

    expect(spokenRequests(sent)).toHaveLength(0);
    expect(h.conversation.statistics).toMatchObject({ gateCalls: 1, gateFailed: 0 });
  });

  it('answers an utterance once even if the turn closes twice', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-3' });
    await settle();
    await answerGate(send, sent, 'YES');
    const probesAfterFirst = sent.filter((e) => e.type === 'response.create' && e.response).length;

    // A duplicated commit for the same utterance. A second request is queued by the
    // session rather than dropped, so the room would hear the reply twice.
    send({ type: 'input_audio_buffer.committed', item_id: 'item-3' });
    await settle();

    expect(spokenRequests(sent)).toHaveLength(1);
    // And the duplicate is refused *before* it costs anything: asking again would
    // spend a probe on a question already answered.
    expect(sent.filter((e) => e.type === 'response.create' && e.response)).toHaveLength(
      probesAfterFirst,
    );
  });

  it('drops a verdict once a later utterance has closed', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-first' });
    await settle();
    // Somebody else speaks before the verdict lands. The response would carry the
    // conversation as it now stands, so answering would answer *their* utterance —
    // which nothing judged.
    send({ type: 'input_audio_buffer.committed', item_id: 'item-second' });
    await settle();

    await answerGate(send, sent, 'YES');

    expect(spokenRequests(sent)).toHaveLength(0);
    expect(h.conversation.statistics).toMatchObject({ gateSuperseded: 1 });
  });

  it('does not let a duplicated commit rewind the supersession guard', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-a' });
    await settle();
    send({ type: 'input_audio_buffer.committed', item_id: 'item-b' });
    await settle();
    // A duplicate for the *earlier* utterance. The policy ignores it, but if it
    // still moved the marker, item-a's late yes would pass the guard and the bare
    // response would answer item-b.
    send({ type: 'input_audio_buffer.committed', item_id: 'item-a' });
    await settle();

    await answerGate(send, sent, 'YES');

    expect(spokenRequests(sent)).toHaveLength(0);
    expect(h.conversation.statistics).toMatchObject({ gateSuperseded: 1 });
  });

  it('counts a verdict that never came, so a deaf agent is visible', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-4' });
    await settle();
    // The socket dies under the probe — the common way a call ends.
    h.dropFromServer();
    await settle();

    expect(spokenRequests(sent)).toHaveLength(0);
    // Silence from a broken gate and silence from a room nobody addressed are
    // indistinguishable without this.
    expect(h.conversation.statistics).toMatchObject({ gateCalls: 1, gateFailed: 1 });
  });

  it('records the reasoning effort beside the latency it bought', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-6' });
    await settle();
    await answerGate(send, sent, 'YES');

    // The first audio is when the room stops waiting, so this is the figure the
    // effort level moves. Without the level on the same line, a call at `high` and
    // a call at `medium` produce indistinguishable logs and the trade cannot be
    // judged after the fact.
    send({
      type: 'response.output_audio.delta',
      item_id: 'item-6',
      delta: Buffer.alloc(960).toString('base64'),
    });
    await settle();

    expect(infoLines()).toMatch(/voice started \d+ms after asking .*effort high/);
  });
});

describe('what a call leaves in the log', () => {
  it('keeps the room out of it by default', async () => {
    const { h, send } = await speakingHarness();
    active = h;

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-7',
      transcript: 'Emma, can you take a look at the staging cluster?',
    });
    await settle();

    // A call is unauthenticated third-party speech and the log outlives it.
    expect(infoLines()).not.toContain('staging cluster');
    expect(infoLines()).not.toContain('Meeting:Heard');
  });

  it('writes what was said when asked, paired to the utterance by id', async () => {
    vi.mocked(config).meetingTranscriptLogging = 'full';
    const { h, send } = await speakingHarness();
    active = h;

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-8',
      transcript: 'Emma, can you take a look at the staging cluster?',
    });
    await settle();

    // Transcription lags the decision, so the words arrive on their own line and
    // `item=` is what pairs them with the verdict.
    expect(infoLines()).toMatch(/\[Meeting:Heard\] item=item-8 transcript=".*staging cluster/);
  });
});

/**
 * A speaker reading as the participants panel produces one.
 *
 * The id is present on every one of them because it, not the display name, is what a
 * caller comparing two readings has to use — the name is only ever for people to read.
 */
function reading(name: string, id = `spaces/x/devices/${name.length}`) {
  return { id, isSelf: false, who: { kind: 'person' as const, name } };
}

describe('knowing who has the floor', () => {
  it('reports the human the platform named', async () => {
    const { h } = await speakingHarness();
    active = h;

    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));

    expect(h.conversation.currentSpeaker?.who).toEqual({ kind: 'person', name: 'Mario Sarcher' });
  });

  it('reports nobody while the agent itself is the one being captioned', async () => {
    const { h } = await speakingHarness();
    active = h;

    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));
    h.conversation.setCurrentSpeaker({
      id: 'devices/9',
      isSelf: true,
      who: { kind: 'person', name: 'Iris' },
    });

    // Not the stale human. Whoever reads this wants "which human has the floor", and
    // answering with the last person who spoke before the agent started talking is how a
    // follow-up gets attributed to the wrong speaker.
    expect(h.conversation.currentSpeaker).toBeNull();
  });

  it('keeps the last speaker when a read comes back empty', async () => {
    const { h } = await speakingHarness();
    active = h;

    h.conversation.setCurrentSpeaker(reading('Emma Lee'));
    // Captions off, pane cleared, or the read failed — all arrive as null, and none of
    // them is evidence that the person who was talking has stopped.
    h.conversation.setCurrentSpeaker(null);

    expect(h.conversation.currentSpeaker?.who).toEqual({ kind: 'person', name: 'Emma Lee' });
  });

  it('forgets a speaker that has gone stale', async () => {
    const { h } = await speakingHarness();
    active = h;
    h.conversation.setCurrentSpeaker(reading('Emma Lee'));

    // Only the clock is faked: the harness runs a real socket, and faking timers would
    // stall it. Past the freshness bound the pane has plainly cleared, and holding the
    // name would keep naming somebody who stopped talking a minute ago.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6_001 });
    try {
      expect(h.conversation.currentSpeaker).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts how often a closed utterance had a speaker attached', async () => {
    const { h, send } = await speakingHarness();
    active = h;

    h.conversation.setCurrentSpeaker(reading('Emma Lee'));
    // Counted when the turn detector closes an utterance, not when a transcript arrives:
    // transcription is only requested when the log is going to carry the words, so a
    // counter on the transcript would read zero on every default-configured call.
    send({ type: 'input_audio_buffer.committed', item_id: 'item-40' });
    await settle();
    await settle();

    // The rate this feeds is the only signal that a scrape of somebody else's UI has
    // stopped working: the call carries on either way, just anonymously.
    expect(h.conversation.statistics).toMatchObject({
      attributedUtterances: 1,
      unattributedUtterances: 0,
    });
  });

  it('counts an unattributed utterance when the platform said nothing', async () => {
    const { h, send } = await speakingHarness();
    active = h;

    send({ type: 'input_audio_buffer.committed', item_id: 'item-41' });
    await settle();
    await settle();

    expect(h.conversation.statistics).toMatchObject({
      attributedUtterances: 0,
      unattributedUtterances: 1,
    });
  });
});

describe('taking captured audio in', () => {
  /** Every `input_audio_buffer.append` on the wire, oldest first. */
  const appends = (sent: Record<string, unknown>[]): string[] =>
    sent.filter((e) => e.type === 'input_audio_buffer.append').map((e) => String(e.audio));

  it('halves the rate of what the caller pushes', async () => {
    const { h, sent } = await speakingHarness();
    active = h;

    // 10 ms of 48 kHz pcm16 mono: 480 samples, two bytes each.
    h.conversation.pushAudio(Buffer.alloc(960));
    await settle();

    // The same 10 ms at the 24 kHz the Realtime API takes: 240 samples.
    const audio = appends(sent);
    expect(audio).toHaveLength(1);
    expect(Buffer.from(audio[0]!, 'base64')).toHaveLength(480);
  });

  it('sends what the caller pushes untouched when the transport speaks 24 kHz', async () => {
    // A transport already on the model's rate skips both resamplers, so the bytes
    // the client captured are the bytes the model receives. That is what makes the
    // socket path free of conversion at either end.
    const { h, sent } = await speakingHarness(REALTIME_SAMPLE_RATE);
    active = h;

    h.conversation.pushAudio(Buffer.alloc(480));
    await settle();

    const audio = appends(sent);
    expect(audio).toHaveLength(1);
    expect(Buffer.from(audio[0]!, 'base64')).toHaveLength(480);
  });

  it('refuses a rate it has no converter for', () => {
    // 2:1 decimation is the whole of the resampler, so a third rate would change
    // pitch rather than fail. Better to refuse at construction.
    expect(
      () =>
        new VoiceConversation({
          instructions: 'x',
          tools: { declarations: [], count: 0, execute: vi.fn() },
          sink: { write: vi.fn() },
          agentName: 'Prism',
          sampleRate: 16_000,
          // Pointed at nothing: the rate is refused before anything connects, and
          // a session left resolving the real endpoint outlives the test.
          endpointOverride: { url: 'ws://127.0.0.1:1', headers: {} },
          spend: { purpose: 'meeting', requestId: 'call-1' },
        }),
    ).toThrow(/16000/);
  });

  it('sends nothing after the conversation stops', async () => {
    const { h, sent } = await speakingHarness();
    active = h;

    h.conversation.stop();
    await settle();
    h.conversation.pushAudio(Buffer.alloc(960));
    await settle();

    expect(appends(sent)).toHaveLength(0);
  });
});

describe('deferred tools', () => {
  const declaration = (name: string) => ({ name, description: name, parameters: {} });

  it('declares what a load_tools call loaded before it sends the call\'s output', async () => {
    let declarations = [declaration('load_tools')];
    const tools = {
      get declarations() {
        return declarations;
      },
      count: 2,
      catalog: '# Tool Catalog\n- gh__create_issue',
      execute: vi.fn(async () => {
        declarations = [declaration('gh__create_issue'), declaration('load_tools')];
        return 'Loaded gh__create_issue.';
      }),
    };
    const { h, send, sent } = await speakingHarness(MEETING_SAMPLE_RATE, { tools });
    active = h;
    await settle();

    const configured = sent.find((e) => e.type === 'session.update') as Record<string, any>;
    expect(configured.session.instructions).toContain('# Tool Catalog\n- gh__create_issue');

    send({
      type: 'response.function_call_arguments.done',
      call_id: 'call-1',
      name: 'load_tools',
      arguments: '{"names":["gh__create_issue"]}',
    });
    await settle();

    const update = sent.findIndex(
      (e) => e.type === 'session.update' && (e as Record<string, any>).session.tools?.length === 2,
    );
    const output = sent.findIndex(
      (e) => e.type === 'conversation.item.create' && (e as Record<string, any>).item.type === 'function_call_output',
    );
    expect(update).toBeGreaterThan(-1);
    expect(output).toBeGreaterThan(update);
    expect((sent[update] as Record<string, any>).session.tools.map((t: { name: string }) => t.name)).toEqual([
      'gh__create_issue',
      'load_tools',
    ]);
  });
});

describe('tool spend', () => {
  it('runs a tool inside the session\'s spend context', async () => {
    let seen: ReturnType<typeof currentSpendContext>;
    const tools = {
      declarations: [{ name: 'code', description: 'code', parameters: {} }],
      count: 1,
      execute: vi.fn(async () => {
        seen = currentSpendContext();
        return 'done';
      }),
    };
    const { h, send } = await speakingHarness(MEETING_SAMPLE_RATE, {
      tools,
      spend: { purpose: 'meeting', requestId: 'call-7', threadId: 'thread-7' },
    });
    active = h;

    send({ type: 'response.function_call_arguments.done', call_id: 'c1', name: 'code', arguments: '{}' });
    await settle();

    expect(tools.execute).toHaveBeenCalled();
    expect(seen).toEqual({ requestId: 'call-7', threadId: 'thread-7', source: { kind: 'meeting' } });
  });
});

describe('ending with a written answer', () => {
  it('asks the whole call, then closes without reporting a lost session', async () => {
    const lost: string[] = [];
    const { h, send, sent } = await speakingHarness(MEETING_SAMPLE_RATE, {
      responseMode: 'open',
      onSessionLost: (reason) => lost.push(reason),
    });
    active = h;

    const answer = h.conversation.stopWithText({ instructions: 'Summarize the call.', deadlineMs: 1_000 });
    await settle();

    const request = probeSent(sent)!;
    expect(request.response.instructions).toBe('Summarize the call.');
    // No input, so the model reads every item of the call.
    expect(request.response.input).toBeUndefined();
    send({
      type: 'response.done',
      response: {
        id: 'r-summary',
        status: 'completed',
        metadata: request.response.metadata,
        output: [{ content: [{ text: 'You asked about the deploy.' }] }],
      },
    });

    await expect(answer).resolves.toBe('You asked about the deploy.');
    await settle();
    expect(lost).toEqual([]);
    await expect(h.conversation.stopWithText({ instructions: 'again', deadlineMs: 100 })).resolves.toBeNull();
  });

  it('answers no utterance that closes while it writes', async () => {
    const { h, send, sent } = await speakingHarness(MEETING_SAMPLE_RATE, { responseMode: 'open' });
    active = h;

    void h.conversation.stopWithText({ instructions: 'Summarize the call.', deadlineMs: 1_000 });
    send({ type: 'input_audio_buffer.committed', item_id: 'item-late' });
    await settle();

    expect(spokenRequests(sent)).toHaveLength(0);
  });
});

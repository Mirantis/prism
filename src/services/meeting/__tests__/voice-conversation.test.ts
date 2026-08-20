/**
 * The seam between a dead Realtime session and the service that owns the call.
 *
 * Run against a real local WebSocket server rather than a mocked session, because
 * the distinction being tested — a close the server initiated versus one we asked
 * for — only exists at the socket level.
 */

import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { config } from '../../../config';
import { logger } from '../../../logger';
import { VoiceConversation } from '../voice-conversation';
import { classifyAddressed, CLASSIFY_DEADLINE_MS } from '../addressed-classifier';
import { judgeFollowUp } from '../follow-up-judge';

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

// The gate is a network call to a classification model; what these tests exercise
// is the ordering around its verdict, not the verdict itself. `CLASSIFY_DEADLINE_MS`
// stays real — the code compares elapsed time against it, and a mocked-away constant
// would quietly disable a staleness check the tests depend on *not* firing.
vi.mock('../addressed-classifier', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../addressed-classifier')>()),
  classifyAddressed: vi.fn(),
}));

// The follow-up judge is a second network call, and these tests are about what the
// conversation does with its answer — and about what it shows it, which no unit test of the
// judge can see. `CONTEXT_LINES` stays real: the conversation sizes its transcript ring from
// it, and a mocked-away constant would make the ring the wrong length in the one test that
// checks what the judge is given.
vi.mock('../follow-up-judge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../follow-up-judge')>()),
  judgeFollowUp: vi.fn(),
}));

beforeAll(async () => {
  // These tests run the *real* vocative read — several of them check which path decides
  // — and its POS tagger is imported lazily, measured at ~59ms. Inside a test, that
  // import competes with an assertion window built from two 20ms settles, so a slow
  // runner would see no response at all. Warmed once here so no test races a module load.
  const { isVocativeAddress } = await import('../vocative');
  await isVocativeAddress('warm the tagger', 'nobody');
});

beforeEach(() => {
  vi.mocked(classifyAddressed).mockResolvedValue(true);
  // Declining by default, so an exchange left open by one test cannot answer another test's
  // utterance behind its back. The cases about following up set it themselves.
  vi.mocked(judgeFollowUp).mockResolvedValue(false);
  vi.mocked(logger.info).mockClear();
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
    endpointOverride: { url: `ws://127.0.0.1:${port}`, headers: {} },
    onSessionLost: (reason) => lost.push(reason),
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
async function speakingHarness(): Promise<{
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
    // Named, so the gate decides — the path the early verdict lives on.
    responseMode: 'addressed',
    endpointOverride: { url: `ws://127.0.0.1:${port}`, headers: {} },
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
  // The local read is off by default in production, so it is off by default here. A test
  // that wants it turns it on and this puts it back.
  (config as { meetingLocalAddressedRead: boolean }).meetingLocalAddressedRead = false;
});

/** Turn the local grammar read on for one test, as `MEETING_LOCAL_ADDRESSED_READ=true` does. */
function withLocalRead(): void {
  (config as { meetingLocalAddressedRead: boolean }).meetingLocalAddressedRead = true;
}

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

/**
 * A verdict reached from a partial transcript decides *whether* to answer; the
 * turn boundary decides *when*.
 *
 * Acting on the verdict the moment it arrived is what made the agent talk over the
 * end of a request and answer only the part it had heard — reported from a live
 * call as "it didn't hear the full sentence before it started to answer". The
 * classification still runs early, concurrently with the rest of the sentence, so
 * nothing is waiting on it once the speaker stops.
 */
describe('answering a request judged early', () => {
  it('stays quiet until the speaker stops, then answers', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    // Mid-sentence: enough text for the gate, which says the agent was named.
    send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'Emma, could you check the',
    });
    await settle();
    await settle();

    // The speaker is still talking. Answering here would cut across the rest of
    // the request — the failure this ordering exists to prevent.
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(0);

    send({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    await settle();

    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
  });

  it('answers once, not once per verdict', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;

    // The same utterance is judged repeatedly as it grows; only one answer may
    // result, or the room hears the reply twice (a second `response.create` is
    // queued by the session, not dropped).
    send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'Emma, could you check the deployment',
    });
    await settle();
    send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: ' in staging and tell us what you find?',
    });
    await settle();
    await settle();

    send({ type: 'input_audio_buffer.committed', item_id: 'item-1' });
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'Emma, could you check the deployment in staging and tell us what you find?',
    });
    await settle();
    await settle();

    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
  });

  it('records the reasoning effort beside the latency it bought', async () => {
    const { h, send } = await speakingHarness();
    active = h;

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-6',
      transcript: 'Prism, how many pods are unhealthy?',
    });
    await settle();
    await settle();

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

describe('recording what each verdict was reached on', () => {
  // Names the agent without addressing it, so the local vocative read defers and these
  // tests keep exercising the model path they are about. A vocative ("Emma, can you take
  // a look?") is decided locally, which makes the mocked gate irrelevant and every
  // `addressed=false` assertion below unreachable. The verdict line itself is still
  // written either way — it says `path=local` — so what changes is the verdict, not
  // whether there is a line to redact.
  const UTTERANCE = 'I asked Emma about that yesterday';

  afterEach(() => {
    // Put the default back by hand. `mockReset`/`restoreMocks` restore spies, not a
    // plain property assigned on the mocked config object, so a test that left this
    // at `full` would un-redact every test that ran after it — and the one that
    // asserts nothing leaks would pass for the wrong reason.
    vi.mocked(config).meetingTranscriptLogging = 'off';
  });

  it('records the verdict, the item and the keyword count, but not the words', async () => {
    const { h, send } = await speakingHarness();
    active = h;
    vi.mocked(classifyAddressed).mockResolvedValue(false);
    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-4',
      transcript: UTTERANCE,
    });
    await settle();
    await settle();

    // What the default keeps: enough to tell "the gate said no" from "the gate never
    // ran", to pair a partial verdict with the final one, and to see whether a roster
    // had arrived — the agent's own name leads the list, so a count of 3 means two
    // participants were read.
    const line = infoLines();
    expect(line).toContain('addressed=false');
    expect(line).toContain('item=item-4');
    expect(line).toContain('mode=addressed');
    expect(line).toContain('keywords=3');
    // What it drops: the sentence, and any stand-in for it — no length, no digest.
    expect(line).not.toContain(UTTERANCE);
    expect(line).not.toContain('sha256');
    expect(line).not.toContain('chars=');
    // Not even an empty `transcript=`: a token with nothing after it reads as a
    // sentence that failed to transcribe rather than one deliberately not written.
    expect(line).not.toContain('transcript=');
  });

  it('keeps the roster out of the log even once the participants have been read', async () => {
    const { h, send } = await speakingHarness();
    active = h;
    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-7',
      transcript: UTTERANCE,
    });
    await settle();
    await settle();

    // Attendee names are the other half of what a meeting log was leaking, and they
    // arrive from a scrape of the call's UI — nobody in the room asked for them to be
    // written down. Asserted across every line, not just the gate's: the roster is
    // also seeded to the transcriber, and that line used to be the count it is now.
    const line = infoLines();
    expect(line).not.toContain('Mario Sarcher');
    expect(line).not.toContain('Lee');
  });

  it('pairs the partial verdict with the final one by item id alone', async () => {
    const { h, send } = await speakingHarness();
    active = h;
    vi.mocked(classifyAddressed).mockResolvedValue(false);

    // One utterance judged twice: once from a partial transcript (long enough to earn
    // an early verdict), then from the finished one. With the words off the line,
    // `item=` is the only thing tying those two verdicts to the same sentence — so it
    // is the one token whose absence would make the default setting undiagnosable.
    send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-8',
      delta: 'I asked Emma about that',
    });
    await settle();
    await settle();
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-8',
      transcript: UTTERANCE,
    });
    await settle();
    await settle();

    const lines = infoLines();
    expect(lines.match(/item=item-8/g)).toHaveLength(2);
    expect(lines).toContain('partial verdict');
    expect(lines).toContain('final verdict');
    expect(lines).not.toContain(UTTERANCE);
  });

  it('writes the sentence and the roster only when asked for them', async () => {
    const { h, send } = await speakingHarness();
    active = h;
    vi.mocked(config).meetingTranscriptLogging = 'full';
    vi.mocked(classifyAddressed).mockResolvedValue(false);
    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-4',
      transcript: UTTERANCE,
    });
    await settle();
    await settle();

    // A `no` on a sentence that names the agent and a `no` on one that never
    // mentions it are the same line without the transcript, which is what made a
    // live report of "it stopped answering to its name" undiagnosable after the
    // fact. This is the mode to turn on for that, in a room that knows.
    const line = infoLines();
    expect(line).toContain(UTTERANCE);
    expect(line).toContain('addressed=false');
    expect(line).toContain('item=item-4');
    // The roster is seeded to the transcriber, so it is an input to whether the name
    // survived at all — and it is the one that changes across a call.
    expect(line).toMatch(/keywords=\[Emma, Lee, Mario Sarcher\]/);
  });

  it('reports the connect-time keyword list before any roster arrives', async () => {
    const { h, send } = await speakingHarness();
    active = h;

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-5',
      transcript: 'Emma, hello',
    });
    await settle();
    await settle();

    // The session seeds the agent's own name at connect; a verdict logged before the
    // first participant poll must say so rather than claim nothing was set. Under the
    // default that is what `keywords=1` means, and it is the reason the count is
    // written at all when the names are not.
    expect(infoLines()).toContain('keywords=1');

    vi.mocked(config).meetingTranscriptLogging = 'full';
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-6',
      transcript: 'Emma, still there?',
    });
    await settle();
    await settle();

    expect(infoLines()).toMatch(/keywords=\[Emma\]/);
  });
});

describe('telling the session who is in the room', () => {
  it('hints the transcriber and informs the model, once per change', async () => {
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
    // The agent's own name leads: it is the one word the gate cannot work without.
    expect(keywords?.[0]).toBe('Emma');
    expect(keywords).toContain('Mario Sarcher');

    // The model is told separately — it cannot read the transcriber's config, and
    // "who is in this call?" is a question the room actually asks.
    const context = sent.filter((e) => e.type === 'conversation.item.create');
    expect(JSON.stringify(context)).toContain('Mario Sarcher');
    // ...and not told it is talking to itself.
    expect(JSON.stringify(context)).not.toContain('are now: Emma');

    // Re-sending an unchanged roster would mutate a live session every poll.
    const before = sent.length;
    h.conversation.setParticipantNames(['Emma', 'Mario Sarcher', 'Lee']);
    await settle();
    expect(sent.length).toBe(before);
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

describe('answering a spoken name without asking the model', () => {
  it('skips the gate entirely when the sentence is a vocative', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;
    // Made to say no, so a response can only come from the local read. If the gate
    // were still consulted the agent would stay silent here.
    withLocalRead();
    vi.mocked(classifyAddressed).mockResolvedValue(false);

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-30',
      transcript: 'Emma, can you take a look?',
    });
    await settle();
    await settle();

    expect(vi.mocked(classifyAddressed)).not.toHaveBeenCalled();
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
    expect(infoLines()).toContain('path=local');
  });

  it('asks the model about a plainly named address, with the local read off', async () => {
    // The shipped default. A local grammar read used to answer this one for free; it is now
    // opt-in, because its only way to fail is answering a room that addressed nobody.
    const { h, send, sent } = await speakingHarness();
    active = h;
    vi.mocked(classifyAddressed).mockResolvedValue(true);

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-34',
      transcript: 'Emma, can you take a look?',
    });
    await settle();
    await settle();

    expect(vi.mocked(classifyAddressed)).toHaveBeenCalledTimes(1);
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(1);
    expect(infoLines()).toContain('local read off');
  });

  it('still asks the model about a sentence that only mentions the agent', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;
    vi.mocked(classifyAddressed).mockResolvedValue(false);

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-31',
      transcript: 'I asked Emma about that yesterday',
    });
    await settle();
    await settle();

    // The local read only ever says yes, so everything it declines must go to the
    // model — otherwise the fast path would be silencing utterances, which its
    // YES-only contract forbids.
    expect(vi.mocked(classifyAddressed)).toHaveBeenCalledTimes(1);
    expect(sent.filter((e) => e.type === 'response.create')).toHaveLength(0);
    expect(infoLines()).toContain('path=model');
  });

  it('counts which path decided, so the saving is measurable on a real call', async () => {
    const { h, send } = await speakingHarness();
    active = h;
    withLocalRead();
    vi.mocked(classifyAddressed).mockResolvedValue(false);

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-32',
      transcript: 'Emma, are you there?',
    });
    await settle();
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-33',
      transcript: 'the deploy went out at four',
    });
    await settle();
    await settle();

    // Their ratio is what the `meeting ended` event reports as `gate_local_share`.
    expect(h.conversation.statistics).toMatchObject({ gateLocalYes: 1, gateModelCalls: 1 });
  });
});

/**
 * A speaker reading as the participants panel produces one.
 *
 * The id is what the follow-up window compares, so it has to be present and stable
 * across readings of the same person — the display name is only ever for people to read.
 */
function reading(name: string, id = `spaces/x/devices/${name.length}`) {
  return { id, name, isSelf: false, isGroup: false };
}

describe('knowing who has the floor', () => {
  it('reports the human the platform named', async () => {
    const { h } = await speakingHarness();
    active = h;

    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));

    expect(h.conversation.currentSpeaker).toMatchObject({ name: 'Mario Sarcher', isGroup: false });
  });

  it('reports nobody while the agent itself is the one being captioned', async () => {
    const { h } = await speakingHarness();
    active = h;

    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));
    h.conversation.setCurrentSpeaker({ id: 'devices/9', name: 'Iris', isSelf: true, isGroup: false });

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

    expect(h.conversation.currentSpeaker).toMatchObject({ name: 'Emma Lee' });
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

  it('counts how often a finished utterance had a speaker attached', async () => {
    const { h, send } = await speakingHarness();
    active = h;

    h.conversation.setCurrentSpeaker(reading('Emma Lee'));
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-40',
      transcript: 'the deploy went out at four',
    });
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

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-41',
      transcript: 'the deploy went out at four',
    });
    await settle();
    await settle();

    expect(h.conversation.statistics).toMatchObject({
      attributedUtterances: 0,
      unattributedUtterances: 1,
    });
  });
});

describe('staying in an exchange after the agent has spoken', () => {
  /** 24 kHz pcm16 silence, which is what the session hands to playback. */
  const audioDelta = (ms: number) => ({
    type: 'response.output_audio.delta',
    item_id: 'a1',
    delta: Buffer.alloc(Math.round(24_000 * 2 * (ms / 1000))).toString('base64'),
  });

  it('answers an unnamed follow-up once its own turn has ended', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;
    // The gate answers yes only for the sentence that names the agent, so an answer to
    // anything else can only have come from the exchange.
    vi.mocked(classifyAddressed).mockImplementation(async ({ transcript }) =>
      /emma/i.test(transcript),
    );
    vi.mocked(judgeFollowUp).mockResolvedValue(true);
    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));
    h.conversation.setParticipantNames(['Mario Sarcher', 'Prismith']);

    // Addressed by name, which arms the window.
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-50',
      transcript: 'Emma, can you check the deploy?',
    });
    await settle();

    // The agent speaks and runs out. The window is measured from here rather than from the
    // question, because what somebody follows up on is the answer — so without this the
    // follow-up below is declined.
    // Past the playback pre-roll, so it actually starts, then long enough for the device to
    // run dry — which is the moment the room stops hearing the agent.
    send(audioDelta(120));
    // The turn is over as far as the server is concerned. Without this the session holds
    // the next `response.create` back — it defers while one is still open, so the room
    // hears one reply rather than two spliced together.
    send({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    await new Promise((r) => setTimeout(r, 500));

    const before = sent.filter((e) => e.type === 'response.create').length;
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-51',
      transcript: 'and can you check staging as well?',
    });
    await settle();
    await settle();

    expect(sent.filter((e) => e.type === 'response.create').length).toBe(before + 1);
    expect(h.conversation.statistics.followUpAccepted).toBe(1);

    // What the judge was shown, which is the only thing that lets it tell a follow-up from an
    // aside: who said each line, and that the agent answered in between. The labels come from
    // the participants panel, and the agent's own marker is written when the room has actually
    // heard the turn — written when the turn *starts*, it landed before the question that
    // prompted it, because an answer decided from a partial transcript is spoken at the turn
    // boundary and the finished transcript arrives afterwards.
    expect(vi.mocked(judgeFollowUp).mock.calls[0][0]).toEqual({
      agentName: 'Emma',
      itemId: 'item-51',
      // Who else is in the room, which is what stops a question for one of them reading as
      // a continuation. Asserted here rather than only in the judge's own tests, because
      // the wiring is what broke live: the gates were given the sentence and nothing else.
      roster: ['Mario Sarcher', 'Prismith'],
      lines: [
        { speaker: 'Mario Sarcher', text: 'Emma, can you check the deploy?' },
        { speaker: 'Emma', text: '(answered)' },
        { speaker: 'Mario Sarcher', text: 'and can you check staging as well?' },
      ],
    });
  });

  it('starts the follow-up clock when the speaker starts, not when they stop', async () => {
    // The test at the seam, and the one that was missing. `follow-up-window.ts` had a unit test
    // proving it stamps an utterance's start from a partial, and `response-policy.ts` had one
    // proving the clock uses that stamp — but the conversation passed no words on a partial, so
    // the window only ever saw finished sentences and the stamp was unreachable. Two live calls
    // failed on exactly that while both unit tests stayed green. Only a test that drives the
    // conversation can see it.
    const { h, send, sent } = await speakingHarness();
    active = h;
    vi.mocked(classifyAddressed).mockImplementation(async ({ transcript }) =>
      /emma/i.test(transcript),
    );
    vi.mocked(judgeFollowUp).mockResolvedValue(true);
    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-56',
      transcript: 'Emma, can you check the deploy?',
    });
    await settle();
    send(audioDelta(120));
    send({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    await new Promise((r) => setTimeout(r, 500));

    const before = sent.filter((e) => e.type === 'response.create').length;

    // The follow-up begins here, well inside the window.
    send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-57',
      delta: 'so on that deploy, I was wondering whether',
    });
    await settle();
    await settle();

    // ...and takes another twelve seconds to say, which is what live speech is like. Only the
    // clock is faked: the harness runs a real socket.
    const later = Date.now() + 12_000;
    vi.useFakeTimers({ toFake: ['Date'], now: later });
    try {
      send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-57',
        transcript: 'can you check whether staging picked it up?',
      });
      await settle();
      await settle();
    } finally {
      vi.useRealTimers();
    }

    expect(sent.filter((e) => e.type === 'response.create').length).toBe(before + 1);
    expect(h.conversation.statistics.followUpAccepted).toBe(1);
  });

  it('asks the gate about a verdict that arrived too late to use', async () => {
    // The one path on which this feature could make the agent *quieter* than switching it
    // off. An utterance inside an open exchange is not asked about the name first, so a slow
    // judge call — the SDK retries twice under throttling — used to drop the verdict and
    // with it a sentence that may well have named the agent.
    const { h, send, sent } = await speakingHarness();
    active = h;
    vi.mocked(classifyAddressed).mockImplementation(async ({ transcript }) =>
      /emma/i.test(transcript),
    );
    vi.mocked(judgeFollowUp).mockResolvedValue(true);
    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-70',
      transcript: 'Emma, can you check the deploy?',
    });
    await settle();
    send(audioDelta(120));
    send({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    await new Promise((r) => setTimeout(r, 500));

    const before = sent.filter((e) => e.type === 'response.create').length;
    // Only the clock is faked; the harness runs a real socket. The judge takes longer than
    // the deadline, and says yes.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(judgeFollowUp).mockImplementation(async () => {
      vi.setSystemTime(Date.now() + CLASSIFY_DEADLINE_MS + 1_000);
      return true;
    });
    try {
      send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-71',
        transcript: 'and can you check staging as well?',
      });
      await settle();
      await settle();
    } finally {
      vi.useRealTimers();
    }

    // Not answered as a follow-up — the room has moved on by six seconds — but the sentence
    // still reached the gate, so nothing was silenced by the judge being slow.
    expect(sent.filter((e) => e.type === 'response.create').length).toBe(before);
    expect(vi.mocked(classifyAddressed)).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'and can you check staging as well?' }),
    );
    expect(h.conversation.statistics.followUpDeclined).toBe(1);
  });

  it('still asks the gate about an utterance the judge turns down', async () => {
    const { h, send, sent } = await speakingHarness();
    active = h;
    vi.mocked(classifyAddressed).mockImplementation(async ({ transcript }) =>
      /emma/i.test(transcript),
    );
    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-52',
      transcript: 'Emma, can you check the deploy?',
    });
    await settle();
    send(audioDelta(120));
    send({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    await new Promise((r) => setTimeout(r, 500));

    const before = sent.filter((e) => e.type === 'response.create').length;
    // Inside the window and question-shaped, and the judge reads it as being for a colleague.
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-53',
      transcript: 'Tom, do you know the default port for MySQL?',
    });
    await settle();
    await settle();

    expect(sent.filter((e) => e.type === 'response.create').length).toBe(before);
    // Declined, not silenced. The exchange can only ever *add* an answer, so a sentence it
    // turns down has to reach the gate — which is where a name the judge read as a colleague's
    // but is really the agent's gets a second look.
    expect(vi.mocked(classifyAddressed)).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: 'Tom, do you know the default port for MySQL?' }),
    );
    expect(h.conversation.statistics.followUpDeclined).toBe(1);
  });
});

describe('who else is in the room', () => {
  it('gives the addressed gate the names it needs to rule a sentence out', async () => {
    // The live failure this covers: with a second agent in the call, "Prismith, can you ask
    // from Iris who was speaking last?" was answered by Iris. The gate is asked about one
    // name and shown a sentence — without the others it cannot see whose the sentence is.
    const { h, send } = await speakingHarness();
    active = h;
    vi.mocked(classifyAddressed).mockResolvedValue(false);
    h.conversation.setParticipantNames(['Mario Sarcher', 'Prismith']);

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-80',
      transcript: 'Prismith, can you ask from Emma who was speaking last?',
    });
    await settle();
    await settle();

    expect(vi.mocked(classifyAddressed)).toHaveBeenCalledWith(
      expect.objectContaining({ roster: ['Mario Sarcher', 'Prismith'] }),
    );
  });
});

describe('the follow-up window while the agent is still being heard', () => {
  const audioDelta = (ms: number) => ({
    type: 'response.output_audio.delta',
    item_id: 'a1',
    delta: Buffer.alloc(Math.round(24_000 * 2 * (ms / 1000))).toString('base64'),
  });

  it('re-suspends the window when audio resumes after the turn looked finished', async () => {
    // Measured live. `responseOpen` covers a gap inside one response, but the session fires a
    // *deferred* response itself on `response.done` without going through `answer()` — so the
    // clock started at the gap and kept running while she talked for another five seconds, and
    // the window expired before she stopped. Any audio reaching the room has to suspend it,
    // whichever path asked for the response.
    const { h, send } = await speakingHarness();
    active = h;
    vi.mocked(classifyAddressed).mockImplementation(async ({ transcript }) =>
      /emma/i.test(transcript),
    );
    h.conversation.setCurrentSpeaker(reading('Mario Sarcher'));

    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-60',
      transcript: 'Emma, can you explain that?',
    });
    await settle();

    // She speaks, the server says the response is done, and playback drains — so the window
    // opens.
    send(audioDelta(120));
    send({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
    await new Promise((r) => setTimeout(r, 500));
    expect(h.conversation.responsePolicy.followUpOpen).toBe(true);

    // Then more audio arrives without a new request, exactly as a deferred response does.
    send(audioDelta(120));
    await settle();

    expect(h.conversation.responsePolicy.followUpOpen).toBe(false);
  });
});

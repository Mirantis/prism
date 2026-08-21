/**
 * The gate judges an utterance it never reads. These tests therefore check two
 * things: that the question put to the model is the right one, and that every way
 * of getting no answer keeps the agent quiet.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { config } from '../../../config';
import { logger } from '../../../logger';
import {
  ADDRESSED_DEADLINE_MS,
  buildAddressedGatePrompt,
  judgeAddressed,
  type OutOfBandAsk,
} from '../addressed-audio-gate';

vi.mock('../../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** A session that answers every probe with `answer`, recording what it was asked. */
function sessionAnswering(answer: string | null): OutOfBandAsk & {
  asked: Array<Record<string, unknown>>;
} {
  const asked: Array<Record<string, unknown>> = [];
  return {
    asked,
    requestOutOfBandText: (request) => {
      asked.push(request as unknown as Record<string, unknown>);
      return Promise.resolve(answer);
    },
  };
}

function lines(level: 'info' | 'warn'): string {
  return vi
    .mocked(logger[level])
    .mock.calls.map((c) => String(c[0]))
    .join('\n');
}

const room = { agentName: 'Prism', roster: ['Emma', 'Mario'] };

beforeEach(() => {
  vi.clearAllMocks();
  config.meetingTranscriptLogging = 'off';
});

describe('what the gate asks', () => {
  it('inherits the call rather than scoping itself to one utterance', async () => {
    const session = sessionAnswering('YES');
    await judgeAddressed(session, { ...room, itemId: 'item-9' });

    expect(session.asked).toHaveLength(1);
    const request = session.asked[0];
    // No `input`, deliberately: an explicit one replaces the session's conversation,
    // and a probe that can only see the utterance being judged cannot tell an
    // unnamed follow-up ("did you find anything?") from one colleague asking
    // another. The conversation is the evidence that question needs.
    expect(request.input).toBeUndefined();
    // The utterance is still named in metadata, so a verdict can be logged and
    // filed against the turn it belongs to.
    expect(request.metadata).toMatchObject({ item: 'item-9' });
    expect(request.deadlineMs).toBe(ADDRESSED_DEADLINE_MS);
    // Measured against a live session: inheriting the session's `high` effort
    // doubles the wait for the same word, and at a tight budget it never reaches
    // the word at all — the response comes back empty, which this gate reads as a
    // failure and answers with silence.
    expect(request.reasoningEffort).toBe('low');
    expect(request.maxOutputTokens).toBe(64);
  });

  it('tells the model who else is in the room', () => {
    const prompt = buildAddressedGatePrompt(room);
    expect(prompt).toContain('Prism');
    expect(prompt).toContain('Emma, Mario');
    // The case the text gate got wrong: a request aimed at somebody else that
    // names the agent inside it.
    expect(prompt).toMatch(/spoken to\s+Emma/);
  });

  it('says plainly when the room is unknown rather than implying an empty one', () => {
    const prompt = buildAddressedGatePrompt({ agentName: 'Prism', roster: [] });
    expect(prompt).toMatch(/do not know who else/i);
    expect(prompt).not.toMatch(/Other people in the call: \./);
  });
});

describe('reading the verdict', () => {
  it('answers when the model says yes', async () => {
    const verdict = await judgeAddressed(sessionAnswering('YES'), { ...room, itemId: 'i-1' });
    expect(verdict).toMatchObject({ addressed: true, failed: false });
  });

  it('stays quiet when the model says no', async () => {
    const verdict = await judgeAddressed(sessionAnswering('NO'), { ...room, itemId: 'i-1' });
    expect(verdict).toMatchObject({ addressed: false, failed: false });
  });

  it('takes the first standalone verdict out of an explanation it cut off', async () => {
    // Observed from the text gate: the token budget truncates mid-sentence.
    const verdict = await judgeAddressed(sessionAnswering('NO\n\nThis is a'), {
      ...room,
      itemId: 'i-1',
    });
    expect(verdict.addressed).toBe(false);
    expect(verdict.failed).toBe(false);
  });

  it('does not read a verdict out of a word that merely contains one', async () => {
    const verdict = await judgeAddressed(sessionAnswering('YESTERDAY'), { ...room, itemId: 'i-1' });
    expect(verdict.addressed).toBe(false);
  });

  it('treats an answer with neither word as no', async () => {
    const verdict = await judgeAddressed(sessionAnswering('I am not sure about that'), {
      ...room,
      itemId: 'i-1',
    });
    // A judgement was made, so this is not a failure — just not a yes.
    expect(verdict).toMatchObject({ addressed: false, failed: false });
  });
});

describe('when there is no verdict to be had', () => {
  it('stays quiet and says the agent was deaf, not unaddressed', async () => {
    const verdict = await judgeAddressed(sessionAnswering(null), { ...room, itemId: 'i-1' });

    expect(verdict.addressed).toBe(false);
    // The distinction telemetry needs: a mute agent looks exactly like a quiet one.
    expect(verdict.failed).toBe(true);
    expect(lines('warn')).toMatch(/No verdict for item=i-1/);
  });

  it('still judges an utterance the session could not name', async () => {
    const session = sessionAnswering('YES');
    const verdict = await judgeAddressed(session, { ...room, itemId: '' });

    // Nothing needs pointing at any more: the probe judges the conversation's
    // latest utterance, so a missing id costs a legible log line rather than a
    // verdict. It used to be refused outright, when an `item_reference` was the
    // only way to say which utterance was meant.
    expect(session.asked).toHaveLength(1);
    expect(verdict).toMatchObject({ addressed: true, failed: false });
  });
});

describe('what the verdict line carries', () => {
  it('writes the verdict, the utterance and the wait without naming anyone', async () => {
    await judgeAddressed(sessionAnswering('NO, that was meant for Emma'), {
      ...room,
      itemId: 'item-4',
    });

    const line = lines('info');
    expect(line).toMatch(/addressed=false/);
    expect(line).toMatch(/item=item-4/);
    expect(line).toMatch(/\d+ms/);
    // Off by default: the roster is real people, and the model's own words quote
    // the room by naming somebody in it.
    expect(line).toContain('roster=2');
    expect(line).not.toContain('Emma');
  });

  it('adds the room and the model’s own words when asked for them', async () => {
    config.meetingTranscriptLogging = 'full';
    await judgeAddressed(sessionAnswering('NO, that was meant for Emma'), {
      ...room,
      itemId: 'item-4',
    });

    const line = lines('info');
    expect(line).toContain('roster=[Emma, Mario]');
    expect(line).toMatch(/said=.*meant for Emma/);
  });
});

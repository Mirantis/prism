/** The route that takes the answers to a question card. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

const { mockAnswer, config } = vi.hoisted(() => ({
  mockAnswer: vi.fn(),
  config: { agentId: 'agent-1' as string | undefined, ownerUserId: 'user-1' },
}));

vi.mock('../services/question-cards/question-card.service', () => ({ questionCardService: { answer: mockAnswer } }));
vi.mock('../config', () => ({ config }));

import { questionCardsRouter } from './question-cards';

const CARD = { type: 'question_card', id: 'card-1', status: 'answered', questions: [], otherMaxLength: 500 };
const URL = '/agents/question-cards/card-1/answer';
const BODY = { answers: [{ options: [0] }] };

function app() {
  const server = express();
  server.use(express.json());
  server.use('/agents', questionCardsRouter);
  return server;
}

describe('POST /agents/question-cards/:id/answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.agentId = 'agent-1';
  });

  it('takes the answers for the owner, and names the sender from the ingress headers', async () => {
    mockAnswer.mockResolvedValue({ result: 'answered', card: CARD });

    const response = await request(app())
      .post(URL)
      .set('x-forwarded-user-id', 'ada-id')
      .set('x-forwarded-user-display-name', encodeURIComponent('Åda Example'))
      .send(BODY);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ card: CARD });
    expect(mockAnswer).toHaveBeenCalledWith('agent-1', 'user-1', 'card-1', BODY.answers, { id: 'ada-id', name: 'Åda Example' });
  });

  it('passes no sender when the ingress named nobody', async () => {
    mockAnswer.mockResolvedValue({ result: 'answered', card: CARD });
    await request(app()).post(URL).send(BODY);
    expect(mockAnswer.mock.calls[0][4]).toBeNull();
  });

  it('answers 409 with the stored card when the card is closed', async () => {
    mockAnswer.mockResolvedValue({ result: 'closed', card: CARD });
    const response = await request(app()).post(URL).send(BODY);
    expect(response.status).toBe(409);
    expect(response.body.card).toEqual(CARD);
    expect(response.body.error).toEqual(expect.any(String));
  });

  it('answers 202 and says the reply is pending when the answer message could not be accepted', async () => {
    mockAnswer.mockResolvedValue({ result: 'reply_pending', card: CARD });
    const response = await request(app()).post(URL).send(BODY);
    expect(response.status).toBe(202);
    expect(response.body).toEqual({ card: CARD, replyPending: true });
  });

  it('answers 404 for a card that does not exist', async () => {
    mockAnswer.mockResolvedValue({ result: 'not_found' });
    expect((await request(app()).post(URL).send(BODY)).status).toBe(404);
  });

  it('answers 400 with the reason when the answers do not fit the card', async () => {
    mockAnswer.mockResolvedValue({ result: 'invalid', error: 'That option does not exist.' });
    const response = await request(app()).post(URL).send(BODY);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('That option does not exist.');
  });

  it('answers 503 until the agent has started', async () => {
    config.agentId = undefined;
    expect((await request(app()).post(URL).send(BODY)).status).toBe(503);
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it.each([
    ['no answers', {}],
    ['an empty list', { answers: [] }],
    ['more than seven answers', { answers: Array.from({ length: 8 }, () => ({ options: [] })) }],
    ['a negative option', { answers: [{ options: [-1] }] }],
    ['a fractional option', { answers: [{ options: [0.5] }] }],
    ['more than four options', { answers: [{ options: [0, 1, 2, 3, 4] }] }],
    ['Other over 500 characters', { answers: [{ options: [], other: 'x'.repeat(501) }] }],
  ])('answers 400 for %s', async (_name, body) => {
    expect((await request(app()).post(URL).send(body)).status).toBe(400);
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('takes Other at exactly 500 characters', async () => {
    mockAnswer.mockResolvedValue({ result: 'answered', card: CARD });
    const response = await request(app()).post(URL).send({ answers: [{ options: [], other: 'x'.repeat(500) }] });
    expect(response.status).toBe(200);
  });
});

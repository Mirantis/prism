import { Router } from 'express';
import { config } from '../config';
import { senderOf } from '../lib/forwarded-sender';
import { answerBodySchema } from '../services/question-cards/question-card-schema';
import { questionCardService } from '../services/question-cards/question-card.service';

/** Answers to the agent's question cards. The first answer wins; any later one gets the stored card. */
export const questionCardsRouter = Router();

questionCardsRouter.post('/question-cards/:id/answer', async (req, res) => {
  if (!config.agentId) {
    res.status(503).json({ error: 'Agent is not initialized.' });
    return;
  }
  const body = answerBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Those answers do not fit the card.' });
    return;
  }
  const outcome = await questionCardService.answer(
    config.agentId,
    config.ownerUserId,
    String(req.params.id),
    body.data.answers,
    senderOf(req),
  );
  if (outcome.result === 'not_found') {
    res.status(404).json({ error: 'That question card does not exist.' });
    return;
  }
  if (outcome.result === 'invalid') {
    res.status(400).json({ error: outcome.error });
    return;
  }
  if (outcome.result === 'closed') {
    res.status(409).json({ error: 'These questions are already closed.', card: outcome.card });
    return;
  }
  if (outcome.result === 'reply_pending') {
    res.status(202).json({ card: outcome.card, replyPending: true });
    return;
  }
  res.json({ card: outcome.card });
});

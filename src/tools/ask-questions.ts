/**
 * `ask_questions`: the agent asks the person one or more questions as a card
 * with answer options. Chat only, since a person is there to answer. Every
 * string here is static, because the tools block has to stay byte-identical.
 */

import { Tool, tool } from 'ai';
import type { ChannelName } from '../services/channel-adapter.interface';
import {
  ASK_QUESTIONS_TOOL_NAME,
  askQuestionsInputSchema,
} from '../services/question-cards/question-card-schema';
import { questionCardService } from '../services/question-cards/question-card.service';

export const ASK_QUESTIONS_RESULT = {
  success: true,
  message:
    'The questions are posted. End this turn now and write nothing else. The answers arrive as the user\'s next message.',
};

export function getAskQuestionsTools(
  userId: string,
  agentId: string,
  threadId: string | undefined,
  originChannel: ChannelName,
  originChannelId: string | undefined,
): Record<string, Tool> {
  if (!threadId) return {};
  return {
    [ASK_QUESTIONS_TOOL_NAME]: tool({
      description:
        'Ask the user one or more questions as a card with answer options they can click. Use it when you need ' +
        'their decisions before you can go on, above all when there are several: put every question in one call, ' +
        'in the order they should answer them. Give each question 2 to 4 options, and name one as recommended when ' +
        'you have a view. The user can always leave a question blank or, unless allowOther is false, write their ' +
        'own answer. Do not write the questions in your reply as well. Put any lead-in in intro, and write no other ' +
        'text in this reply. For a single open question with no natural options, ask in plain text instead. Call it ' +
        'once, then end your turn and write nothing else. The answers ' +
        'arrive as the user\'s next message, one line per question; a blank question reads "no answer".',
      inputSchema: askQuestionsInputSchema,
      execute: async (input) => {
        await questionCardService.post({ userId, agentId, threadId, originChannel, originChannelId }, input);
        return ASK_QUESTIONS_RESULT;
      },
    }),
  };
}

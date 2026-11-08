/**
 * What a question card may hold: the limits, and the shapes the `ask_questions`
 * tool, the stored block and the answer route accept.
 */

import { z } from 'zod';

export const ASK_QUESTIONS_TOOL_NAME = 'ask_questions';

export const MAX_QUESTIONS = 7;
const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
const MAX_QUESTION_CHARS = 300;
const MAX_HEADER_CHARS = 40;
const MAX_LABEL_CHARS = 80;
const MAX_DETAIL_CHARS = 200;
const MAX_INTRO_CHARS = 300;
export const MAX_OTHER_CHARS = 500;

const optionSchema = z.object({
  label: z.string().trim().min(1).max(MAX_LABEL_CHARS).describe('The answer, in a few words.'),
  detail: z.string().trim().max(MAX_DETAIL_CHARS).optional().describe('One line on what this answer means.'),
});

const questionSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_QUESTION_CHARS).describe('The question.'),
    header: z.string().trim().max(MAX_HEADER_CHARS).optional().describe('A short topic label, such as "Budget".'),
    options: z.array(optionSchema).min(MIN_OPTIONS).max(MAX_OPTIONS),
    recommended: z.string().optional().describe('The label of the option you recommend, written exactly as that label.'),
    allowOther: z.boolean().default(true).describe('Offer "Other…" with a text field.'),
    multiSelect: z.boolean().default(false).describe('Let the user choose several options.'),
  })
  .superRefine((question, context) => {
    const labels = question.options.map((option) => option.label);
    if (new Set(labels).size !== labels.length) {
      context.addIssue({ code: 'custom', path: ['options'], message: 'Each option label must be different.' });
    }
    if (question.recommended !== undefined && !labels.includes(question.recommended)) {
      context.addIssue({ code: 'custom', path: ['recommended'], message: 'recommended must equal one option label.' });
    }
  });

export const askQuestionsInputSchema = z.object({
  intro: z
    .string()
    .trim()
    .max(MAX_INTRO_CHARS)
    .optional()
    .describe('One short plain-text line shown above the questions.'),
  questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS),
});

const answerSchema = z.object({
  options: z.array(z.number().int().min(0)).max(MAX_OPTIONS),
  other: z.string().trim().max(MAX_OTHER_CHARS).optional(),
});

/** A card as a message stores it. Other routes can store any block, so a read checks the shape. */
export const questionCardBlockSchema = z.object({
  type: z.literal('question_card'),
  id: z.string(),
  status: z.enum(['waiting', 'answered', 'answered_in_chat']),
  intro: z.string().max(MAX_INTRO_CHARS).optional(),
  questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS),
  otherMaxLength: z.number().int().positive(),
  answers: z.array(answerSchema).optional(),
  answeredBy: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
});

/** The answer route's body: one entry per question, in the card's order. */
export const answerBodySchema = z.object({
  answers: z.array(answerSchema).min(1).max(MAX_QUESTIONS),
});

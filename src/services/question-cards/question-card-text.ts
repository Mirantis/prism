/** The two texts of a question card: the card as plain text, and the answers as the person's message. */

import type { QuestionCardAnswer, QuestionCardQuestion } from '../../protocol/chat-protocol';

const CLOSING_LINE = 'Reply with 1a, 2b… or in your own words.';
const NO_ANSWER = 'no answer';

/** Line breaks collapse to one space, so that each question stays one line of the answer message. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

function optionLine(question: QuestionCardQuestion, optionIndex: number): string {
  const { label, detail } = question.options[optionIndex];
  const letter = String.fromCharCode(97 + optionIndex);
  const recommended = question.recommended === label ? ' (recommended)' : '';
  return `   ${letter}) ${label}${detail ? ` – ${detail}` : ''}${recommended}`;
}

function questionBlock(question: QuestionCardQuestion, index: number): string {
  const header = question.header ? `${question.header}: ` : '';
  const hint = question.multiSelect ? ' Choose any.' : '';
  const lines = question.options.map((_, optionIndex) => optionLine(question, optionIndex));
  return [`${index + 1}. ${header}${question.text}${hint}`, ...lines].join('\n');
}

/** The message text of a card, which every channel that cannot draw the card shows. */
export function questionCardText(questions: QuestionCardQuestion[], intro?: string): string {
  return [...(intro ? [intro] : []), questions.map(questionBlock).join('\n'), CLOSING_LINE].join('\n\n');
}

function answerSubject(question: QuestionCardQuestion): string {
  if (question.header) return `${oneLine(question.header)}:`;
  const text = oneLine(question.text);
  return /[?!:.]$/.test(text) ? text : `${text}:`;
}

function answerLine(question: QuestionCardQuestion, answer: QuestionCardAnswer, index: number): string {
  const labels = answer.options.map((option) => oneLine(question.options[option].label));
  const chosen = [...labels, ...(answer.other ? [answer.other] : [])];
  return `${index + 1}. ${answerSubject(question)} ${chosen.length > 0 ? chosen.join(', ') : NO_ANSWER}`;
}

/** The message stored as the person's own: one line per question. */
export function answerMessageText(questions: QuestionCardQuestion[], answers: QuestionCardAnswer[]): string {
  return questions.map((question, index) => answerLine(question, answers[index], index)).join('\n');
}

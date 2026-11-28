import type { QuestionCardAnswer, QuestionCardBlock, QuestionCardQuestion } from '@/types';

/** What the person has chosen for one question, in this page only. */
export interface QuestionChoice {
  options: number[];
  /** The text in the question's own-answer field. Whitespace alone is no answer. */
  otherText: string;
}

export const emptyChoice = (): QuestionChoice => ({ options: [], otherText: '' });

export function isAnswered(choice: QuestionChoice): boolean {
  return choice.options.length > 0 || choice.otherText.trim().length > 0;
}

export function answeredCount(choices: QuestionChoice[]): number {
  return choices.filter(isAnswered).length;
}

/** A single-select question takes one answer, so choosing an option empties the own-answer field. */
export function toggleOption(choice: QuestionChoice, option: number, multiSelect: boolean): QuestionChoice {
  if (!multiSelect) return { options: [option], otherText: '' };
  const options = choice.options.includes(option)
    ? choice.options.filter((chosen) => chosen !== option)
    : [...choice.options, option].sort((a, b) => a - b);
  return { ...choice, options };
}

/** On a single-select question, typing an answer of one's own clears the chosen option. */
export function setOtherText(choice: QuestionChoice, otherText: string, multiSelect: boolean): QuestionChoice {
  if (multiSelect || !otherText.trim()) return { ...choice, otherText };
  return { options: [], otherText };
}

/** The answer route's body for these choices. */
export function toAnswers(choices: QuestionChoice[]): QuestionCardAnswer[] {
  return choices.map((choice) => {
    const other = choice.otherText.trim();
    return { options: choice.options, ...(other ? { other } : {}) };
  });
}

/** The stored answers that hold anything. */
export function storedAnsweredCount(card: QuestionCardBlock): number {
  return card.answers?.filter((answer) => answer.options.length > 0 || answer.other).length ?? 0;
}

/** One answer as a read-only list of what was chosen. */
export function answerLabels(question: QuestionCardQuestion, answer: QuestionCardAnswer | undefined): string[] {
  if (!answer) return [];
  return [...answer.options.flatMap((option) => question.options[option]?.label ?? []), ...(answer.other ? [answer.other] : [])];
}

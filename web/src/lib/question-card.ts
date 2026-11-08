import type { QuestionCardAnswer, QuestionCardBlock, QuestionCardQuestion } from '@/types';

/** What the person has chosen for one question, in this page only. */
export interface QuestionChoice {
  options: number[];
  /** "Other…" is chosen, so its field is open. */
  otherOpen: boolean;
  /** Kept when the field closes, so that choosing "Other…" again brings it back. */
  otherText: string;
}

export const emptyChoice = (): QuestionChoice => ({ options: [], otherOpen: false, otherText: '' });

/** An "Other…" left empty counts as no answer. */
export function isAnswered(choice: QuestionChoice): boolean {
  return choice.options.length > 0 || (choice.otherOpen && choice.otherText.trim().length > 0);
}

export function answeredCount(choices: QuestionChoice[]): number {
  return choices.filter(isAnswered).length;
}

export function toggleOption(choice: QuestionChoice, option: number, multiSelect: boolean): QuestionChoice {
  if (!multiSelect) return { ...choice, options: [option], otherOpen: false };
  const options = choice.options.includes(option)
    ? choice.options.filter((chosen) => chosen !== option)
    : [...choice.options, option].sort((a, b) => a - b);
  return { ...choice, options };
}

export function toggleOther(choice: QuestionChoice, multiSelect: boolean): QuestionChoice {
  if (!multiSelect) return { ...choice, options: [], otherOpen: true };
  return { ...choice, otherOpen: !choice.otherOpen };
}

/** The answer route's body for these choices. */
export function toAnswers(choices: QuestionChoice[]): QuestionCardAnswer[] {
  return choices.map((choice) => {
    const other = choice.otherOpen ? choice.otherText.trim() : '';
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

import { STEP_LIMIT } from '../constants';

export const EARLY_STOPPING_PROMPT = `You have used all ${STEP_LIMIT} steps this turn allows. From what you have found so far, give the best answer you can to the original request, and say what is left undone.`;

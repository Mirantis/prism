import { STEP_LIMIT } from '../constants';

export const EARLY_STOPPING_PROMPT = `You have reached the maximum number of iterations (${STEP_LIMIT}).
Based on the information gathered so far, please provide a helpful final response to the user's original query.
Do not attempt to use any more tools. Simply summarize what you have learned and provide the best possible answer.`;

/**
 * What a model is told when it continues work a restart interrupted.
 */

/**
 * Where a chat reply continues after a restart interrupted it: the last message
 * of the history, stored there, so every later turn replays the same prompt.
 */
export const RESUMED_REPLY_NOTICE =
  'Runtime notice: the runtime restarted while you were answering the messages above, and your answer continues here. ' +
  'The steps above ran before the restart. ' +
  'A step after the last one shown may have run too, so check its effect before you do it again.';

/**
 * After the prompt of a webhook run, a scheduled task or a goal turn that the
 * boot starts. A run of the same work may have stopped part-way at the restart.
 */
export const RESUMED_RUN_NOTICE =
  'Runtime notice: the runtime restarted before this run, and a run of the same work may have stopped part-way at the restart. ' +
  'Its steps may already have had effects, so check the result of a step before you do it again.';

/** The prompt a coding agent's session continues with after a restart stopped it. */
export const RESUMED_CODING_TASK_PROMPT =
  'The runtime restarted and stopped this session before you finished. ' +
  'Continue the task from where you stopped. Check the state of the files before you change them again.';

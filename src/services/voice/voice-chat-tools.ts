/**
 * The tool set a voice chat offers: the agent's own, with the meeting tools taken out and
 * the computer's laid over the gap when the session has a computer.
 *
 * The meeting tools go whether or not there is a replacement, since each of them acts on
 * a call this session is not in. `browse` and `see_screen` come back pointed at the
 * computer, under the same names, so the prompt text written for a call still reads true.
 */

import { MEETING_TOOL_NAMES } from '../../tools/meeting';
import type { PreparedTools } from './realtime-tools';

/**
 * What a truncated result tells the model in a voice chat. Speech is the only thing that
 * leaves this call, so there is nowhere to hand the rest of a large result.
 */
export const VOICE_CHAT_TRUNCATION_GUIDANCE =
  'You cannot hand the rest over — speech is what leaves this call, not a result of this ' +
  'size — so say the part that answers the question and offer to go into more of it out ' +
  'loud. If the answer needs something from the omitted middle, search the saved output ' +
  'with a pattern — never read it through, because everything you pull back stays in ' +
  "this call's context for the rest of it, and this session's context is small.";

export function prepareVoiceChatTools(
  base: PreparedTools,
  computer: PreparedTools | null,
): PreparedTools {
  const extra = computer?.declarations ?? [];
  const extraNames = new Set(extra.map((d) => d.name));
  const dropped = new Set<string>([...MEETING_TOOL_NAMES, ...extraNames]);
  const declarations = [...base.declarations.filter((d) => !dropped.has(d.name)), ...extra];
  return {
    declarations,
    count: declarations.length,
    execute: (name, argumentsJson) =>
      computer && extraNames.has(name)
        ? computer.execute(name, argumentsJson)
        : base.execute(name, argumentsJson),
  };
}

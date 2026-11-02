/** Tool assembly for voice chat, including optional desktop control. */

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

/** Remove call-specific tools and route each declaration to its session's executor. */
export function prepareVoiceChatTools(
  base: PreparedTools,
  computer: PreparedTools | null,
): PreparedTools {
  const meetingNames = new Set<string>(MEETING_TOOL_NAMES);
  const computerNames = new Set((computer?.declarations ?? []).map((declaration) => declaration.name));
  const baseNames = () =>
    base.declarations.filter((d) => !meetingNames.has(d.name) && !computerNames.has(d.name));
  // Rebuilt only when a load changes the base set, so an unchanged set keeps its identity.
  let source = base.declarations;
  let declarations = [...baseNames(), ...(computer?.declarations ?? [])];
  return {
    get declarations() {
      if (base.declarations !== source) {
        source = base.declarations;
        declarations = [...baseNames(), ...(computer?.declarations ?? [])];
      }
      return declarations;
    },
    // The base's count includes its deferred tools; the meeting and computer tools are never deferred.
    count: base.count - (base.declarations.length - baseNames().length) + (computer?.count ?? 0),
    ...(base.catalog ? { catalog: base.catalog } : {}),
    execute: (name, argumentsJson) => {
      if (computerNames.has(name)) return computer!.execute(name, argumentsJson);
      if (meetingNames.has(name)) return Promise.resolve(JSON.stringify({ error: `Unknown tool: ${name}` }));
      return base.execute(name, argumentsJson);
    },
  };
}

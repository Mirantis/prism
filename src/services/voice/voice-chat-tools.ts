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
  const tools = new Map(
    base.declarations
      .filter((declaration) => !meetingNames.has(declaration.name))
      .map((declaration) => [declaration.name, { declaration, owner: base }]),
  );
  for (const declaration of computer?.declarations ?? []) {
    tools.set(declaration.name, { declaration, owner: computer! });
  }
  return {
    declarations: [...tools.values()].map(({ declaration }) => declaration),
    count: tools.size,
    execute: (name, argumentsJson) => {
      const tool = tools.get(name);
      if (!tool) return Promise.resolve(JSON.stringify({ error: `Unknown tool: ${name}` }));
      return tool.owner.execute(name, argumentsJson);
    },
  };
}

import { describe, it, expect } from 'vitest';
import { getVoiceChatInstructions } from './voice-chat-prompt';

const base = { agentName: 'Prism', computer: null, userScreen: false };

/** Single-spaced text, so an assertion about wording does not depend on where a line breaks. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('getVoiceChatInstructions', () => {
  it('names no computer tool when the session opened no computer', () => {
    // The computer tools are declared only with a computer, and a model told about a
    // tool it was not given calls it or promises what it does.
    const text = getVoiceChatInstructions({ ...base, responseMode: 'open' });
    expect(text).not.toMatch(/computer_/);
  });

  it.each(['open', 'addressed'] as const)(
    'holds a destructive or self-configuring request for a spoken yes (%s)',
    (responseMode) => {
      // Nothing in voice mode withholds those tools, so this instruction is the guard,
      // and it has to name the agent's own configuration: without the name, a model
      // asked to rename itself calls the tool at once.
      const text = flat(getVoiceChatInstructions({ ...base, responseMode }));
      expect(text).toMatch(/deletes, deploys, spends money, grants access or changes your own configuration/);
      expect(text).toMatch(/changes your own configuration \(your name, your Soul/);
      expect(text).toMatch(/do not call the tool yet/);
    },
  );

  it("speaks the user's language", () => {
    const text = flat(getVoiceChatInstructions({ ...base, responseMode: 'open' }));
    expect(text).toContain('Speak the language your user speaks, and switch when they switch.');
    expect(text).not.toMatch(/English only/);
  });
});

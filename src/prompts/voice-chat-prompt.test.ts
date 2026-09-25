import { describe, it, expect } from 'vitest';
import {
  getVoiceChatBackendInstructions,
  getVoiceChatVoiceInstructions,
  type VoiceChatInstructionsInput,
} from './voice-chat-prompt';

const bare: VoiceChatInstructionsInput = { agentName: 'Prism', computer: null, userScreen: false };
const full: VoiceChatInstructionsInput = {
  agentName: 'Prism',
  computer: { desktop: { width: 1280, height: 800 } },
  userScreen: true,
};

const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('getVoiceChatVoiceInstructions', () => {
  it('lists only what the session has for the backend to do', () => {
    const text = flat(getVoiceChatVoiceInstructions(bare));
    expect(text).toMatch(/run commands and use your integrations/i);
    expect(text).not.toMatch(/your own browser/i);
    expect(text).not.toMatch(/the desktop around that browser/i);
    expect(text).not.toMatch(/sharing from their own screen/i);
  });

  it('names the browser, the desktop and the shared screen when the session has them', () => {
    const text = flat(getVoiceChatVoiceInstructions(full));
    expect(text).toMatch(/act on them in your own browser/i);
    expect(text).toMatch(/use the desktop around that browser/i);
    expect(text).toMatch(/look at what your user is sharing from their own screen/i);
  });

  it('answers its user and stays out of other conversations around them', () => {
    const text = flat(getVoiceChatVoiceInstructions(bare));
    expect(text).toMatch(/Your user is talking to you/i);
    expect(text).toMatch(/keep listening and say nothing until somebody speaks to you/i);
  });

  it('numbers its rules without a gap', () => {
    const numbers = [...getVoiceChatVoiceInstructions(full).matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

describe('getVoiceChatBackendInstructions', () => {
  it('writes speech for the voice, and keeps its mechanics to itself', () => {
    const text = flat(getVoiceChatBackendInstructions(bare));
    expect(text).toMatch(/the voice says out loud to your user/i);
    expect(text).toMatch(/no markdown/i);
    expect(text).toMatch(/Never mention which tool you used/i);
  });

  it('carries the screen, browser and desktop rules only when the session has them', () => {
    const without = getVoiceChatBackendInstructions(bare);
    expect(without).not.toMatch(/## Your user's screen/);
    expect(without).not.toMatch(/## Your browser/);

    const withAll = flat(getVoiceChatBackendInstructions(full));
    expect(withAll).toMatch(/## Your user's screen/);
    expect(withAll).toMatch(/`computer_user_screen`/);
    expect(withAll).toMatch(/## Your browser/);
    expect(withAll).toMatch(/1280 by 800 picture/);
  });

  it('numbers the sections straight on from its own rules', () => {
    const numbers = [...getVoiceChatBackendInstructions(full).matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });
});

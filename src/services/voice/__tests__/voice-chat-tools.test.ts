import { describe, expect, it } from 'vitest';
import { prepareVoiceChatTools } from '../voice-chat-tools';
import type { PreparedTools } from '../realtime-tools';

// The meeting tool list is the real one, so a tool added there is dropped here without
// this file being touched.

/** A prepared set that records which of its tools were run. */
function set(names: string[]): PreparedTools & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    declarations: names.map((name) => ({ name, description: name, parameters: {} })),
    count: names.length,
    execute: async (name) => {
      ran.push(name);
      return name;
    },
  };
}

describe('prepareVoiceChatTools', () => {
  it('drops the meeting tools, which act on a call this session is not in', () => {
    const base = set(['memory_search', 'join_meeting', 'leave_meeting', 'send_meeting_chat']);
    const tools = prepareVoiceChatTools(base, null);
    expect(tools.declarations.map((d) => d.name)).toEqual(['memory_search']);
    expect(tools.count).toBe(1);
  });

  it("puts the computer's tools in the place of the meeting's, under the same names", () => {
    const base = set(['memory_search', 'browse', 'see_screen']);
    const computer = set(['browse', 'see_screen', 'desktop_click']);
    const tools = prepareVoiceChatTools(base, computer);
    expect(tools.declarations.map((d) => d.name)).toEqual([
      'memory_search',
      'browse',
      'see_screen',
      'desktop_click',
    ]);
  });

  it('routes a call to the set it came from', async () => {
    const base = set(['memory_search', 'browse']);
    const computer = set(['browse', 'desktop_click']);
    const tools = prepareVoiceChatTools(base, computer);

    await tools.execute('memory_search', '{}');
    await tools.execute('browse', '{}');
    await tools.execute('desktop_click', '{}');

    // `browse` exists in both, and the computer's is the one that acts on something.
    expect(base.ran).toEqual(['memory_search']);
    expect(computer.ran).toEqual(['browse', 'desktop_click']);
  });

  it("keeps the agent's own tools when there is no computer", async () => {
    const base = set(['memory_search', 'browse']);
    const tools = prepareVoiceChatTools(base, null);
    await tools.execute('browse', '{}');
    expect(base.ran).toEqual(['browse']);
  });

  it('declares a name once, whichever set it came from', () => {
    const base = set(['browse']);
    const computer = set(['browse']);
    const names = prepareVoiceChatTools(base, computer).declarations.map((d) => d.name);
    expect(names).toEqual(['browse']);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { prepareVoiceChatTools } from '../voice-chat-tools';

// A voice session's computer is the runtime's own desktop, which offers the browser tool.
vi.mock('../../computer/supported', async (original) => ({
  ...(await original<typeof import('../../computer/supported')>()),
  hasComputer: () => true,
}));
import { getComputerTools } from '../../../tools/computer';
import { MEETING_TOOL_NAMES } from '../../../tools/meeting';
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

const computerNames = Object.keys(getComputerTools(undefined, () => null));

describe('prepareVoiceChatTools', () => {
  it('omits call-specific tools and refuses to execute them', async () => {
    const base = set(['memory_search', ...MEETING_TOOL_NAMES]);
    const tools = prepareVoiceChatTools(base, null);
    expect(tools.declarations.map((d) => d.name)).toEqual(['memory_search']);
    expect(tools.count).toBe(1);
    expect(await tools.execute('browse', '{}')).toContain('Unknown tool');
    expect(base.ran).toEqual([]);
  });

  it('follows the base declarations when a load adds to them, and keeps their identity otherwise', () => {
    let declarations = [{ name: 'memory_search', description: '', parameters: {} }];
    const base: PreparedTools = {
      get declarations() {
        return declarations;
      },
      count: 2,
      execute: async () => '',
    };
    const tools = prepareVoiceChatTools(base, set(['computer_screen']));
    const before = tools.declarations;
    expect(tools.declarations).toBe(before);
    // The base counts its deferred tool, as the meeting path does.
    expect(tools.count).toBe(3);

    declarations = [...declarations, { name: 'gh__create_issue', description: '', parameters: {} }];

    expect(tools.declarations).not.toBe(before);
    expect(tools.declarations.map((d) => d.name)).toEqual(['memory_search', 'gh__create_issue', 'computer_screen']);
  });

  it('adds the computer declarations used by a real voice session', () => {
    const base = set(['memory_search', ...MEETING_TOOL_NAMES]);
    const tools = prepareVoiceChatTools(base, set(computerNames));
    expect(tools.declarations.map((d) => d.name)).toEqual(['memory_search', ...computerNames]);
    expect(computerNames).toEqual(
      expect.arrayContaining([
        'computer_browse',
        'computer_screen',
        'computer_click',
        'computer_instruct',
      ]),
    );
    expect(computerNames).not.toEqual(
      expect.arrayContaining(['browse', 'see_screen', 'desktop_click']),
    );
  });

  it('routes each computer declaration to the computer executor', async () => {
    const base = set(['memory_search', ...MEETING_TOOL_NAMES]);
    const computer = set(computerNames);
    const tools = prepareVoiceChatTools(base, computer);
    await tools.execute('memory_search', '{}');
    for (const name of computerNames) await tools.execute(name, '{}');
    expect(base.ran).toEqual(['memory_search']);
    expect(computer.ran).toEqual(computerNames);
  });

  it('keeps unrelated tools whose names start with computer_', async () => {
    const base = set(['computer_inventory']);
    const tools = prepareVoiceChatTools(base, null);
    expect(tools.declarations.map((d) => d.name)).toEqual(['computer_inventory']);
    await tools.execute('computer_inventory', '{}');
    expect(base.ran).toEqual(['computer_inventory']);
  });

  it('declares a duplicate name once and uses its replacement executor', async () => {
    const base = set(['computer_browse']);
    const computer = set(['computer_browse']);
    const tools = prepareVoiceChatTools(base, computer);
    expect(tools.declarations.map((d) => d.name)).toEqual(['computer_browse']);
    await tools.execute('computer_browse', '{}');
    expect(base.ran).toEqual([]);
    expect(computer.ran).toEqual(['computer_browse']);
  });
});

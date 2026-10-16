import { expect, it, vi } from 'vitest';
import { getComputerTools } from './computer';

// A runtime with a desktop of its own, unless a test says otherwise.
const desktop = vi.hoisted(() => ({ probed: true }));
vi.mock('../services/computer/supported', async (original) => ({
  ...(await original<typeof import('../services/computer/supported')>()),
  hasComputer: () => desktop.probed,
}));

it('uses canonical computer names in declarations and descriptions', () => {
  const tools = getComputerTools();
  for (const [name, tool] of Object.entries(tools)) {
    expect(name).toMatch(/^computer_/);
    expect(tool.description).not.toMatch(/desktop_|see_screen|see_user_screen|`browse`/);
  }
  expect(tools.computer_browse).toBeDefined();
  expect(tools.computer_click).toBeDefined();
});

it('offers the browser tool to a run that uses no remote computer, before the desktop probe', () => {
  // The prompt evals build a chat turn's tools this way, with no startup probe.
  desktop.probed = false;
  try {
    expect(getComputerTools(undefined, undefined, 'chat').computer_browse).toBeDefined();
  } finally {
    desktop.probed = true;
  }
});

it('describes model picture coordinates independently of desktop resolution', () => {
  expect(getComputerTools().computer_click.description).toContain('1280 by 720');
});

it('offers the user screen only to a voice session that supports screen sharing', () => {
  expect(getComputerTools().computer_user_screen).toBeUndefined();
  expect(getComputerTools(undefined, () => null).computer_user_screen).toBeDefined();
});

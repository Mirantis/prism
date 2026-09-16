import { expect, it } from 'vitest';
import { getComputerTools } from './computer';

it('uses canonical computer names in declarations and descriptions', () => {
  const tools = getComputerTools();
  for (const [name, tool] of Object.entries(tools)) {
    expect(name).toMatch(/^computer_/);
    expect(tool.description).not.toMatch(/desktop_|see_screen|see_user_screen|`browse`/);
  }
  expect(tools.computer_browse).toBeDefined();
  expect(tools.computer_click).toBeDefined();
});

it('describes model picture coordinates independently of desktop resolution', () => {
  expect(getComputerTools().computer_click.description).toContain('1280 by 720');
});

it('offers the user screen only to a voice session that supports screen sharing', () => {
  expect(getComputerTools().computer_user_screen).toBeUndefined();
  expect(getComputerTools(undefined, () => null).computer_user_screen).toBeDefined();
});

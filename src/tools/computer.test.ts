import { expect, it } from 'vitest';
import { getComputerTools } from './computer';
import { computerService } from '../services/computer/computer.service';

it('uses canonical computer names in declarations and descriptions', () => {
  const tools = getComputerTools();
  for (const [name, tool] of Object.entries(tools)) {
    expect(name).toMatch(/^computer_/);
    expect(tool.description).not.toMatch(/desktop_|`browse`/);
  }
  expect(tools.computer_browse).toBeDefined();
  expect(tools.computer_click).toBeDefined();
});

it('describes model picture coordinates independently of desktop resolution', () => {
  expect(getComputerTools().computer_click.description).toContain('1280 by 720');
});

it('offers the user screen and the relay to a voice run only', () => {
  const use = (mode: string) => computerService.access.create({ userId: 'u', agentId: 'a', mode });
  expect(getComputerTools(use('chat')).computer_user_screen).toBeUndefined();
  expect(getComputerTools(use('chat')).computer_instruct).toBeUndefined();
  expect(getComputerTools(use('voice')).computer_user_screen).toBeDefined();
  expect(getComputerTools(use('voice')).computer_instruct).toBeDefined();
});

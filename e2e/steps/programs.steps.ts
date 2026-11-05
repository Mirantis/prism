/**
 * Programs that call tools: the agent loops over shell_exec inside run_program.
 */

import { createBdd } from 'playwright-bdd';
import { expect } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { HomePage } from '../pages/home.page';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { When, Then } = createBdd();

When('I ask the agent to square the numbers 1 to 6 with the shell in one program', async ({ page }) => {
  const homePage = new HomePage(page);
  await homePage.typeMessage(
    'Use run_program once: in the program, call shell_exec with `echo $((N*N))` for each N from 1 to 6, ' +
      'and print the sum of the outputs. Then tell me the sum.',
  );
  await homePage.sendMessage();
});

Then('one run_program call made {int} shell calls', async ({ page }, count: number) => {
  await new HomePage(page).waitForStreamComplete();
  // Every AGENT row, hidden steps included: concise mode stores a tool round on an
  // internal row.
  const rows = await dbHelper.getPrisma().conversationMessage.findMany({
    where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT' },
  });
  const calls = rows.flatMap((r) =>
    Array.isArray(r.toolCalls)
      ? (r.toolCalls as Array<{ tool: string; output: string; success: boolean; parentTool?: string }>)
      : [],
  );
  const programs = calls.filter((call) => call.tool === 'run_program');
  const shellCalls = calls.filter((call) => call.tool === 'shell_exec');

  expect(programs, `tool calls: ${JSON.stringify(calls)}`).toHaveLength(1);
  expect(programs[0].output).toContain(`(${count} tool calls)`);
  // The record keeps each call the program made, marked with the tool that ran it.
  expect(shellCalls, 'the shell calls inside the program').toHaveLength(count);
  for (const call of shellCalls) expect(call).toMatchObject({ parentTool: 'run_program', success: true });
});

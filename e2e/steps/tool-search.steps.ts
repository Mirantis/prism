/**
 * On-demand tool loading step definitions. The demo plugin's MCP tool is the
 * deferred tool: the runtime defers every MCP tool when the threshold is 0.
 */

import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { DEFAULT_AGENT_ID } from '../fixtures/test-data';

const { Given, Then } = createBdd();

/**
 * Gated here for the reason `single-thread.steps.ts` gives: the runtime reads the
 * threshold at boot, so this feature is its own invocation —
 *   TOOL_SEARCH_THRESHOLD_PERCENT=0 npm run test:e2e:tool-search --workspace=prism-agent-e2e
 */
Given('the agent loads its MCP tools on demand', async () => {
  test.skip(
    process.env.TOOL_SEARCH_THRESHOLD_PERCENT !== '0',
    'Needs a runtime started with TOOL_SEARCH_THRESHOLD_PERCENT=0.',
  );
});

Then(
  'the stored tool calls include {string} {int} time(s) and {string} {int} time(s)',
  async ({}, first: string, firstCount: number, second: string, secondCount: number) => {
    const rows = await dbHelper.getPrisma().conversationMessage.findMany({
      where: { thread: { agentId: DEFAULT_AGENT_ID }, role: 'AGENT' },
      select: { toolCalls: true },
    });
    const names = rows.flatMap((row) =>
      Array.isArray(row.toolCalls) ? (row.toolCalls as Array<{ tool?: string }>).map((tc) => tc.tool) : [],
    );
    expect(names.filter((name) => name === first)).toHaveLength(firstCount);
    expect(names.filter((name) => name === second)).toHaveLength(secondCount);
  },
);

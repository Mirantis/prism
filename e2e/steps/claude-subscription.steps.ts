import { createBdd } from 'playwright-bdd';
import { expect, test } from '@playwright/test';

const { Given } = createBdd();

Given('the main agent uses a saved Claude subscription', async () => {
  test.skip(process.env.LLM_PROVIDER !== 'claude-subscription', 'Run with LLM_PROVIDER=claude-subscription and a saved Claude browser login.');
  expect(process.env.ANTHROPIC_API_KEY || '').toBe('');
  expect(process.env.CLAUDE_CODE_OAUTH_TOKEN || '').toBe('');
});

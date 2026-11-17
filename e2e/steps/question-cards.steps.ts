/**
 * Question card step definitions.
 *
 * One scenario has the agent call the tool. The others seed a waiting card on an
 * agent message, so they make no model call to get one.
 *
 * Another person is a request with the headers the Mirantis Agent Platform ingress writes. A
 * browser cannot set a header on a WebSocket handshake, so the browser here has
 * no identity and sees "Answered" for its own answer.
 */

import { randomUUID } from 'node:crypto';
import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import { HomePage } from '../pages/home.page';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then } = createBdd();

const CARD_TIMEOUT = 90_000;

// Scenarios run one at a time (workers: 1), so module state belongs to the current scenario.
let seeded: { threadId: string; cardId: string } | undefined;

const CARD_INTRO = 'A few decisions before I draft the launch plan.';
const CARD_ANSWERS = [{ options: [1] }, { options: [] }, { options: [] }];

function seededCard() {
  return {
    type: 'question_card',
    id: randomUUID(),
    status: 'waiting',
    intro: CARD_INTRO,
    otherMaxLength: 500,
    questions: [
      {
        text: 'How much can we spend each month?',
        header: 'Budget',
        options: [{ label: 'Under €500', detail: 'fits the current plan' }, { label: '€500 to €2,000' }],
        recommended: 'Under €500',
        allowOther: true,
        multiSelect: false,
      },
      {
        text: 'Which channels should we use?',
        options: [{ label: 'Newsletter' }, { label: 'Webinar' }],
        allowOther: true,
        multiSelect: true,
      },
      {
        text: 'When should it launch?',
        header: 'Launch',
        options: [{ label: 'This summer' }, { label: 'After the summer' }],
        allowOther: false,
        multiSelect: false,
      },
    ],
  };
}

function card(page: Page) {
  return page.getByTestId('question-card');
}

function answerUrl(): string {
  if (!seeded) throw new Error('No question card was seeded');
  return `/agents/question-cards/${seeded.cardId}/answer`;
}

Given('a conversation with a waiting question card', async ({ page }) => {
  const threadId = await dbHelper.createThread(getCurrentAgentId(), { title: 'Question card' });
  const block = seededCard();
  const response = await page.request.post(`/agents/threads/${threadId}/messages`, {
    data: {
      content: 'The questions as text.',
      role: 'AGENT',
      triggeredBy: 'USER_INPUT',
      blocks: [block],
    },
  });
  expect(response.status()).toBe(201);
  seeded = { threadId, cardId: block.id };
});

When('I open that conversation', async ({ page }) => {
  if (!seeded) throw new Error('No question card was seeded');
  const home = new HomePage(page);
  await home.goto(`/chat/${seeded.threadId}`);
  await page.waitForLoadState('networkidle');
  await home.typeMessage('draft');
  await expect(home.sendButton).toBeEnabled({ timeout: 30_000 });
  await home.typeMessage('');
});

Then('a question card waits with {string}', async ({ page }, title: string) => {
  await expect(card(page)).toHaveAttribute('data-status', 'waiting', { timeout: CARD_TIMEOUT });
  await expect(card(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
});

Then('the answer button is disabled', async ({ page }) => {
  await expect(card(page).getByRole('button', { name: 'Send answers' })).toBeDisabled();
});

When('I choose {string} on the question card', async ({ page }, label: string) => {
  await card(page).getByTestId('question-card-option').filter({ hasText: label }).click();
});

Then('the question card status reads {string}', async ({ page }, status: string) => {
  await expect(card(page).getByTestId('question-card-status')).toHaveText(status);
});

When('I send the question card', async ({ page }) => {
  await card(page).getByRole('button', { name: /^Send answer/ }).click();
});

Then('the question card shows {string}', async ({ page }, title: string) => {
  await expect(card(page).getByRole('heading', { name: title, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(card(page)).not.toHaveAttribute('data-status', 'waiting');
});

Then('the question card shows its intro', async ({ page }) => {
  await expect(card(page).getByTestId('question-card-intro')).toHaveText(CARD_INTRO);
});

Then('the question card hides its intro', async ({ page }) => {
  await expect(card(page).getByTestId('question-card-intro')).toHaveCount(0);
});

When('I show the questions on the question card', async ({ page }) => {
  await card(page).getByRole('button', { name: 'Show questions' }).click();
});

Then('the question card says {string}', async ({ page }, line: string) => {
  await expect(card(page).getByTestId('question-card-notice')).toHaveText(line);
});

Then('the conversation shows my answer {string}', async ({ page }, line: string) => {
  await expect(page.locator('[data-message-role="user"]').filter({ hasText: line })).toHaveCount(1, { timeout: 30_000 });
});

When('{string} answers the question card first', async ({ page }, name: string) => {
  const response = await page.request.post(answerUrl(), {
    headers: {
      'x-forwarded-user-id': randomUUID(),
      'x-forwarded-user-display-name': encodeURIComponent(name),
    },
    data: { answers: CARD_ANSWERS },
  });
  expect(response.status()).toBe(200);
});

Then('another answer to the question card is refused with the stored card', async ({ page }) => {
  const response = await page.request.post(answerUrl(), { data: { answers: [{ options: [0] }, { options: [] }, { options: [] }] } });
  expect(response.status()).toBe(409);
  const { card: stored } = (await response.json()) as { card: { status: string; answers: unknown } };
  expect(stored.status).toBe('answered');
  expect(stored.answers).toEqual(CARD_ANSWERS);
});

Then('the agent has finished its turn', async ({ page }) => {
  await expect
    .poll(async () => ((await (await page.request.get('/agents/state')).json()) as { state: string }).state, {
      timeout: 120_000,
      intervals: [1_000],
    })
    .toBe('idle');
});

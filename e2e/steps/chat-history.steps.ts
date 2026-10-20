/**
 * Chat history step definitions — a long conversation opens on its newest page,
 * and older pages load as the reader scrolls up, without moving what they read.
 */

import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';
import * as dbHelper from '../support/db-helper';
import { getCurrentAgentId } from './common.steps';

const { Given, When, Then } = createBdd();

const messages = (page: Page) => page.getByTestId('chat-messages').locator('[data-message-role]');
const scroller = (page: Page) => page.getByTestId('chat-messages');

/** The first message on screen when the reader reached the top, and where it stood. */
let reading: { text: string; top: number } | undefined;

/** `Message 001`, `Message 002`, …: a fixed width keeps each one unique to a substring match. */
function numbered(i: number): string {
  return `Message ${String(i).padStart(3, '0')}`;
}

async function firstShown(page: Page): Promise<{ text: string; top: number }> {
  const first = messages(page).first();
  const text = (await first.innerText()).match(/Message \d{3}/)?.[0] ?? '';
  const top = (await first.boundingBox())?.y ?? 0;
  return { text, top };
}

Given(
  'a conversation with {int} numbered messages, where the first {int} show an image',
  async ({}, count: number, withImage: number) => {
    // A second apart, so the order on screen is the order written. Each image has its own
    // address, so it loads after its message is on screen and changes the rows' height then.
    const start = Date.now() - count * 1000;
    await dbHelper.createThread(getCurrentAgentId(), {
      messages: Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? ('USER' as const) : ('AGENT' as const),
        content: i < withImage ? `${numbered(i + 1)}\n\n![chart](/prism-logo.svg?n=${i + 1})` : numbered(i + 1),
        createdAt: new Date(start + i * 1000),
      })),
    });
  },
);

When('I scroll up to the oldest message shown', async ({ page }) => {
  await expect(messages(page).first()).toBeVisible();
  // Where the first message stands once the list is at its top, measured before the
  // scroll, so an older page that arrives at once cannot be mistaken for it.
  reading = await scroller(page).evaluate((el) => {
    const first = el.querySelector('[data-message-role]')!;
    const top = first.getBoundingClientRect().top + el.scrollTop;
    el.scrollTop = 0;
    return { text: (first as HTMLElement).innerText.match(/Message \d{3}/)?.[0] ?? '', top };
  });
});

Then(
  'older messages appear above the message I was reading, which stays in place',
  async ({ page }) => {
    const before = reading!;
    await expect.poll(async () => (await firstShown(page)).text).not.toBe(before.text);
    // Measured once the new page's images have loaded and changed its height.
    await expect
      .poll(() => scroller(page).evaluate((el) => [...el.querySelectorAll('img')].every((img) => img.complete)))
      .toBe(true);
    const row = messages(page).filter({ hasText: before.text });
    await expect(row).toBeInViewport();
    const top = (await row.boundingBox())!.y;
    expect(Math.abs(top - before.top), `"${before.text}" moved from ${before.top}px to ${top}px`).toBeLessThan(4);
  },
);

When('I scroll to the start of the conversation', async ({ page }) => {
  await expect
    .poll(
      async () => {
        await scroller(page).evaluate((el) => {
          el.scrollTop = 0;
        });
        return (await firstShown(page)).text;
      },
      { timeout: 30_000 },
    )
    .toBe(numbered(1));
});

Then('the conversation shows all {int} numbered messages in order', async ({ page }, count: number) => {
  const shown = (await messages(page).allInnerTexts()).map((text) => text.match(/Message \d{3}/)?.[0]);
  expect(shown).toEqual(Array.from({ length: count }, (_, i) => numbered(i + 1)));
});

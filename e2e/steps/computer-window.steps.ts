import { createBdd } from 'playwright-bdd';
import { expect, type Page } from '@playwright/test';

const { When, Then } = createBdd();
const windows = new WeakMap<Page, Page>();
const desktop = (page: Page) => page.getByLabel("The agent's screen");

async function streaming(page: Page) {
  await expect(desktop(page)).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => desktop(page).evaluate((canvas: HTMLCanvasElement) => canvas.width))
    .toBe(1920);
}

When('I pop out the computer', async ({ page }) => {
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Pop out', exact: true }).click();
  const popup = await opened;
  windows.set(page, popup);
  await expect(popup).toHaveURL(/\/computer-window/);
  await expect(page.getByRole('region', { name: 'Computer detached' })).toBeVisible();
});

Then('the detached computer fills its window and streams the desktop', async ({ page }) => {
  const popup = windows.get(page)!;
  await streaming(popup);
  await expect(popup.locator('header')).toHaveCount(0);
  const box = await desktop(popup).boundingBox();
  const size = await popup.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  expect(box).toEqual({ x: 0, y: 0, ...size });
});

Then(
  'I can move the floating controls and resize the computer window',
  async ({ page, $testInfo }) => {
    const popup = windows.get(page)!;
    const controls = popup.getByLabel('Floating computer controls', {
      exact: true,
    });
    const handle = popup.getByRole('button', {
      name: 'Move computer controls',
    });
    const original = (await controls.boundingBox())!;
    const grip = (await handle.boundingBox())!;
    await popup.mouse.move(grip.x + 8, grip.y + 8);
    await popup.mouse.down();
    await popup.mouse.move(grip.x + 208, grip.y + 208, { steps: 10 });
    await popup.mouse.up();
    const moved = (await controls.boundingBox())!;
    expect(moved.x).toBeGreaterThan(original.x);
    expect(moved.y).toBeGreaterThan(original.y);
    for (const size of [
      { width: 420, height: 360 },
      { width: 1500, height: 900 },
    ]) {
      await popup.setViewportSize(size);
      await expect
        .poll(async () => {
          const box = (await controls.boundingBox())!;
          return (
            box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= size.width &&
            box.y + box.height <= size.height
          );
        })
        .toBe(true);
      expect(await desktop(popup).boundingBox()).toEqual({
        x: 0,
        y: 0,
        ...size,
      });
    }
    await popup.screenshot({
      path: $testInfo.outputPath('computer-popup.png'),
    });
  },
);

When('I reload the embedded computer page', async ({ page }) => {
  await page.reload();
});
Then('the computer offers Focus window and Restore', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Focus window' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Focus window' }).click();
});
When('I restore the computer', async ({ page }) => {
  const popup = windows.get(page)!;
  const closed = popup.waitForEvent('close');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await closed;
});
When('I close the detached computer', async ({ page }) => {
  await windows.get(page)!.close();
});
When('I close the main computer window', async ({ page }) => {
  await page.close();
});
Then('the embedded computer streams the desktop again', async ({ page }) => {
  await streaming(page);
  await expect(page.getByRole('button', { name: 'Pop out', exact: true })).toBeVisible();
});
When('the browser blocks the computer popup', async ({ page }) => {
  await page.evaluate(() => {
    window.open = () => null;
  });
  await page.getByRole('button', { name: 'Pop out', exact: true }).click();
});
Then('Computer explains how to allow popups', async ({ page }) => {
  await expect(page.getByRole('alert')).toContainText('Allow popups');
});

/**
 * Scheduled Tasks Page Object — /cron.
 *
 * Covers the New-task dialog with its schedule presets, and each task's card in
 * the list. Selectors mirror web/src/routes/cron.tsx and
 * web/src/components/schedules/scheduled-task-item.tsx.
 */

import { Page, Locator } from '@playwright/test';
import { BasePage } from './base.page';

export class ScheduledTasksPage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async navigate() {
    await this.goto('/cron');
    await this.page.waitForLoadState('networkidle');
  }

  /** The header's New-task button; the empty state repeats it, so take the first. */
  get newTaskButton(): Locator {
    return this.page.getByRole('button', { name: 'New task' }).first();
  }

  get dialog(): Locator {
    return this.page.getByRole('dialog');
  }

  /** One task's card in the list. */
  taskRow(name: string): Locator {
    return this.page.getByTestId('scheduled-task').filter({ hasText: name });
  }

  /** Open the dialog, name the task, pick a preset schedule, and submit. */
  async createTaskFromPreset(name: string, preset: string, instruction: string) {
    await this.newTaskButton.click();
    await this.page.locator('#cron-name').fill(name);
    await this.dialog.getByRole('button', { name: preset, exact: true }).click();
    await this.page.locator('#cron-instruction').fill(instruction);
    await this.dialog.getByRole('button', { name: 'Schedule', exact: true }).click();
    await this.taskRow(name).waitFor({ timeout: 10_000 });
  }

  /** Delete a task from its card and confirm; waits for the dialog to close. */
  async deleteTask(name: string) {
    await this.taskRow(name).getByRole('button', { name: `Delete ${name}` }).click();
    const confirm = this.page.getByRole('button', { name: 'Delete', exact: true });
    await confirm.click();
    await confirm.waitFor({ state: 'detached', timeout: 10_000 });
  }
}

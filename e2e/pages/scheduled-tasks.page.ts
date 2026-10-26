/**
 * Scheduled Tasks Page Object — /cron.
 *
 * Covers the New-task and Edit dialogs with their schedule presets, and each
 * task's card in the list. Selectors mirror web/src/routes/cron.tsx and
 * web/src/components/schedules/.
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

  get scheduleButton(): Locator {
    return this.dialog.getByRole('button', { name: 'Schedule', exact: true });
  }

  /** Open the dialog, name the task and pick a preset schedule, without submitting. */
  async startTaskFromPreset(name: string, preset: string) {
    await this.newTaskButton.click();
    await this.page.locator('#cron-name').fill(name);
    await this.dialog.getByRole('button', { name: preset, exact: true }).click();
  }

  async fillInstruction(instruction: string) {
    await this.page.locator('#cron-instruction').fill(instruction);
  }

  /** Pick the open dialog's Deliver to target by its label. */
  async chooseDeliverTo(label: string) {
    await this.page.locator('#cron-deliver-to').click();
    await this.page.getByRole('option', { name: label, exact: true }).click();
    await this.page.getByRole('listbox').waitFor({ state: 'hidden' });
  }

  /** Open the dialog, name the task, pick a preset schedule, and submit. */
  async createTaskFromPreset(name: string, preset: string, instruction: string) {
    await this.startTaskFromPreset(name, preset);
    await this.fillInstruction(instruction);
    await this.scheduleButton.click();
    await this.taskRow(name).waitFor({ timeout: 10_000 });
  }

  /** Open a task's Edit dialog from its card. */
  async openEdit(name: string) {
    await this.taskRow(name).getByRole('button', { name: `Edit ${name}` }).click();
    await this.dialog.waitFor();
  }

  /** Rename the task in the open Edit dialog, pick a preset, replace the instruction, and save. */
  async saveEdit(name: string, preset: string, instruction: string) {
    await this.page.locator('#cron-name').fill(name);
    await this.dialog.getByRole('button', { name: preset, exact: true }).click();
    await this.fillInstruction(instruction);
    await this.dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await this.dialog.waitFor({ state: 'hidden', timeout: 10_000 });
  }

  /** Delete a task from its card and confirm; waits for the dialog to close. */
  async deleteTask(name: string) {
    await this.taskRow(name).getByRole('button', { name: `Delete ${name}` }).click();
    const confirm = this.page.getByRole('button', { name: 'Delete', exact: true });
    await confirm.click();
    await confirm.waitFor({ state: 'detached', timeout: 10_000 });
  }
}

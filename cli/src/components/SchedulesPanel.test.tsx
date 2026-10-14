import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { SchedulesPanel } from './SchedulesPanel.js';
import type { ApiClient } from '../api-client.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
const TAB = '\t';
const ENTER = '\r';

/** Ink parses one write per render, so each key needs the render it belongs to. */
async function type(stdin: { write: (data: string) => void }, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    stdin.write(key);
    await flush();
  }
}

describe('the terminal schedules panel', () => {
  it('creates a task only once it has an instruction', async () => {
    const createCronTask = vi.fn().mockResolvedValue({});
    const api = {
      listCronTasks: vi.fn().mockResolvedValue([]),
      createCronTask,
    } as unknown as ApiClient;
    const { lastFrame, stdin, unmount } = render(<SchedulesPanel api={api} onClose={vi.fn()} />);
    await flush();

    await type(stdin, 'n', 'Morning summary', TAB, 'every day at 9am', ENTER);
    expect(createCronTask).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('All three fields are required.');

    await type(stdin, TAB, 'Summarize my inbox', ENTER);
    expect(createCronTask).toHaveBeenCalledWith({
      name: 'Morning summary',
      schedule: 'every day at 9am',
      instruction: 'Summarize my inbox',
    });
    unmount();
  });

  it('edits the selected task in a form filled with its fields, and sends what changed', async () => {
    const task = {
      id: 'task-1',
      name: 'Deploy check',
      // A schedule the agent stored with the spaces it was given.
      schedule: 'in 10 minutes ',
      recurring: false,
      instruction: 'Is the deploy green?',
      isActive: true,
      lastRunAt: null,
      nextRunAt: '2026-10-13T12:10:00.000Z',
      createdAt: '2026-10-13T12:00:00.000Z',
      updatedAt: '2026-10-13T12:00:00.000Z',
    };
    const updateCronTask = vi.fn().mockResolvedValue({});
    const api = {
      listCronTasks: vi.fn().mockResolvedValue([task]),
      updateCronTask,
    } as unknown as ApiClient;
    const { lastFrame, stdin, unmount } = render(<SchedulesPanel api={api} onClose={vi.fn()} />);
    await flush();

    await type(stdin, 'e');
    expect(lastFrame()).toContain('Edit schedule');
    expect(lastFrame()).toContain('Deploy check');
    expect(lastFrame()).toContain('Runs once, at');

    await type(stdin, ' now', ENTER);
    expect(updateCronTask).toHaveBeenCalledWith('task-1', { name: 'Deploy check now' });
    unmount();
  });

  it('saves an unchanged task without a request', async () => {
    const task = {
      id: 'task-1',
      name: 'Deploy check',
      schedule: '0 9 * * *',
      recurring: true,
      instruction: 'Is the deploy green?',
      isActive: true,
      lastRunAt: null,
      nextRunAt: '2026-10-14T09:00:00.000Z',
      createdAt: '2026-10-13T12:00:00.000Z',
      updatedAt: '2026-10-13T12:00:00.000Z',
    };
    const updateCronTask = vi.fn().mockResolvedValue({});
    const api = {
      listCronTasks: vi.fn().mockResolvedValue([task]),
      updateCronTask,
    } as unknown as ApiClient;
    const { lastFrame, stdin, unmount } = render(<SchedulesPanel api={api} onClose={vi.fn()} />);
    await flush();

    await type(stdin, 'e', ENTER);
    await flush();
    expect(updateCronTask).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('e edit');
    unmount();
  });
});

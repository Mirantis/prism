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
});

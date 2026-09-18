import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { clearPasswordFields } from '../secure-window';
import { logger } from '../../../logger';

/** A tab whose frames answer the clearing script with what they cleared. */
function tab(options: { closed?: boolean; frames: (number | Error)[] }): {
  page: Page;
  selectors: string[];
} {
  const selectors: string[] = [];
  const frames = options.frames.map((answer) => ({
    evaluate: vi.fn(async (_fn: unknown, selector: string) => {
      selectors.push(selector);
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  }));
  const page = {
    isClosed: () => options.closed ?? false,
    frames: () => frames,
  } as unknown as Page;
  return { page, selectors };
}

describe('clearing what a secure takeover left behind', () => {
  it('reaches every frame of every open tab', async () => {
    const first = tab({ frames: [1, 0] });
    const second = tab({ frames: [2] });

    expect(await clearPasswordFields([first.page, second.page])).toBe(3);
    expect(first.selectors).toHaveLength(2);
    expect(second.selectors).toHaveLength(1);
  });

  it('asks for the hidden field and the one a "show password" control revealed', async () => {
    const { page, selectors } = tab({ frames: [0] });

    await clearPasswordFields([page]);
    expect(selectors[0]).toContain('input[type="password" i]');
    expect(selectors[0]).toContain('input[autocomplete*="password" i]');
  });

  it('carries on past a frame that has gone away', async () => {
    const { page } = tab({ frames: [new Error('Frame was detached'), 1] });

    expect(await clearPasswordFields([page])).toBe(1);
  });

  it('says nothing about the frame a sign-in navigated away from', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const { page } = tab({
      frames: [new Error('frame.evaluate: Execution context was destroyed, most likely because of a navigation')],
    });

    expect(await clearPasswordFields([page])).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a frame that answers with anything else', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const { page } = tab({ frames: [new Error('timed out after 5000ms')] });

    await clearPasswordFields([page]);
    expect(warn).toHaveBeenCalled();
  });

  it('leaves a closed tab alone', async () => {
    const { page, selectors } = tab({ closed: true, frames: [1] });

    expect(await clearPasswordFields([page])).toBe(0);
    expect(selectors).toEqual([]);
  });
});

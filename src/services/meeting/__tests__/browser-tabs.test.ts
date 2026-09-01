/**
 * The tab set the agent browses in.
 *
 * Worth testing without a browser, because the contract is what the room sees: the
 * active tab is the tab in front, a tab the site opened counts as one, and a tab that
 * closed must not stay in the list or stay active.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { TabSet } from '../browser-tabs';

function fakePage(name: string) {
  let closed = false;
  const page = {
    name,
    isClosed: () => closed,
    bringToFront: vi.fn(async () => {}),
    close: vi.fn(async () => {
      closed = true;
    }),
    /** Close it the way the site does, without the set being told. */
    dieQuietly: () => {
      closed = true;
    },
  };
  return page as unknown as Page & typeof page;
}

describe('TabSet', () => {
  it('makes a new tab the active one', () => {
    const tabs = new TabSet();
    const first = fakePage('first');
    const second = fakePage('second');

    tabs.add(first);
    tabs.add(second);

    expect(tabs.list()).toEqual([first, second]);
    expect(tabs.current()).toBe(second);
  });

  it('takes a tab the site opened, which is what a target=_blank click produces', () => {
    // The browser puts that tab in front, and the agent that clicked the link expects
    // to be looking at it.
    const tabs = new TabSet();
    const opened = fakePage('opened');

    tabs.add(opened);

    expect(tabs.current()).toBe(opened);
  });

  it('adds a tab once, however many times it arrives', () => {
    const tabs = new TabSet();
    const page = fakePage('one');

    tabs.add(page);
    tabs.add(page);

    expect(tabs.list()).toEqual([page]);
  });

  it('selects by index and brings that tab to the front', async () => {
    const tabs = new TabSet();
    const first = fakePage('first');
    tabs.add(first);
    tabs.add(fakePage('second'));

    expect(await tabs.select(0)).toBe(first);
    expect(tabs.current()).toBe(first);
    expect(first.bringToFront).toHaveBeenCalled();
  });

  it('answers null for a tab that is not there, and changes nothing', async () => {
    const tabs = new TabSet();
    const only = fakePage('only');
    tabs.add(only);

    expect(await tabs.select(4)).toBeNull();
    expect(tabs.current()).toBe(only);
  });

  it('drops a tab the site closed, and moves off it', () => {
    const tabs = new TabSet();
    const first = fakePage('first');
    const second = fakePage('second');
    tabs.add(first);
    tabs.add(second);

    second.dieQuietly();

    expect(tabs.list()).toEqual([first]);
    expect(tabs.current()).toBe(first);
  });

  it('closes a tab and falls back to the one before it', async () => {
    const tabs = new TabSet();
    const first = fakePage('first');
    const second = fakePage('second');
    tabs.add(first);
    tabs.add(second);

    expect(await tabs.close(1)).toBe(true);
    expect(second.close).toHaveBeenCalled();
    expect(tabs.list()).toEqual([first]);
    expect(tabs.current()).toBe(first);
    expect(first.bringToFront).toHaveBeenCalled();
  });

  it('leaves the active tab alone when a background tab closes', async () => {
    // The active tab is the screen the room is watching. Tidying up another tab must
    // not move it.
    const tabs = new TabSet();
    const first = fakePage('first');
    const second = fakePage('second');
    tabs.add(first);
    tabs.add(second);

    expect(await tabs.close(0)).toBe(true);
    expect(tabs.current()).toBe(second);
    expect(second.bringToFront).not.toHaveBeenCalled();
  });

  it('leaves nothing active when the last tab closes', async () => {
    const tabs = new TabSet();
    tabs.add(fakePage('only'));

    expect(await tabs.close(0)).toBe(true);
    expect(tabs.list()).toEqual([]);
    expect(tabs.current()).toBeNull();
  });

  it('refuses to close a tab that is not there', async () => {
    const tabs = new TabSet();
    tabs.add(fakePage('only'));

    expect(await tabs.close(3)).toBe(false);
    expect(tabs.list()).toHaveLength(1);
  });

  it('raises the active tab, and answers null when there is none', async () => {
    const tabs = new TabSet();
    expect(await tabs.raise()).toBeNull();

    const page = fakePage('one');
    tabs.add(page);

    expect(await tabs.raise()).toBe(page);
    expect(page.bringToFront).toHaveBeenCalled();
  });

  it('forgets everything when the browser goes', () => {
    const tabs = new TabSet();
    tabs.add(fakePage('one'));

    tabs.clear();

    expect(tabs.list()).toEqual([]);
    expect(tabs.current()).toBeNull();
  });
});

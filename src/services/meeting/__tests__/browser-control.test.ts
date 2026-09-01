/**
 * Driving a page from a tool call, against a fake Playwright page.
 *
 * What is worth pinning is the contract the model works from: a command it wrote badly
 * is answered rather than thrown, every command comes back with the reading the next
 * one will be written against, and a failed action still says where the page ended up
 * — "the click missed" and "the click went somewhere unexpected" are the same message
 * otherwise.
 */

import { describe, it, expect } from 'vitest';
import type { Page } from 'playwright-core';
import { looksLikeSelector, runBrowserCommand } from '../browser-control';

interface FakePageOptions {
  url?: string;
  title?: string;
  body?: string;
  controls?: string[];
  /** Make the next action throw, the way a locator timing out does. */
  failWith?: string;
}

function fakePage(options: FakePageOptions = {}) {
  const acted: string[] = [];
  let url = options.url ?? 'https://example.test/';

  const fail = () => {
    if (options.failWith) throw new Error(options.failWith);
  };

  /** What a name-based locator was asked to match, so `count()` can answer it. */
  interface NameSpec {
    name: string;
    exact?: boolean;
  }
  const controls = options.controls ?? ['Search', 'Sign in'];
  const hits = (specs: NameSpec[]) =>
    controls.filter((control) =>
      specs.some((spec) => (spec.exact ? control === spec.name : control.includes(spec.name))),
    ).length;

  type FakeLocator = ReturnType<typeof locator>;
  const locator = (name: string, specs: NameSpec[] = []) => ({
    first: (): FakeLocator => locator(name, specs),
    or: (other: FakeLocator): FakeLocator =>
      locator(`${name}|${other._name}`, [...specs, ...other._specs]),
    _name: name,
    _specs: specs,
    // A CSS selector carries no spec and is assumed present; a name-based one answers
    // from the control list, which is what makes the exact-then-partial pass observable.
    count: async () => (specs.length === 0 ? 1 : hits(specs)),
    click: async () => {
      fail();
      acted.push(`click ${name}`);
    },
    fill: async (value: string) => {
      fail();
      acted.push(`fill ${name} = ${value}`);
    },
    innerText: async () => options.body ?? 'Example page',
  });

  /** Names carry `~` when the locator was built for substring matching. */
  const named = (prefix: string, spec: NameSpec) =>
    locator(`${prefix}:${spec.name}${spec.exact ? '' : '~'}`, [spec]);

  const page = {
    url: () => url,
    title: async () => options.title ?? 'Example',
    goto: async (target: string) => {
      fail();
      url = target;
      acted.push(`goto ${target}`);
    },
    locator: (selector: string) => locator(selector),
    getByRole: (role: string, opts: NameSpec) => named(role, opts),
    getByLabel: (name: string, opts?: { exact?: boolean }) => named('label', { name, ...opts }),
    getByPlaceholder: (name: string, opts?: { exact?: boolean }) =>
      named('placeholder', { name, ...opts }),
    getByText: (name: string, opts?: { exact?: boolean }) => named('text', { name, ...opts }),
    // The control probe runs in the browser; here its answer is just handed back.
    evaluate: async () => options.controls ?? ['Search', 'Sign in'],
    keyboard: {
      press: async (key: string) => {
        fail();
        acted.push(`press ${key}`);
      },
      type: async (text: string) => {
        fail();
        acted.push(`type ${text}`);
      },
    },
    mouse: {
      wheel: async (_x: number, y: number) => {
        fail();
        acted.push(`wheel ${y}`);
      },
    },
    waitForLoadState: async () => {},
  };

  return { page: page as unknown as Page, acted };
}

describe('looksLikeSelector', () => {
  it('takes a selector for a selector and words for words', () => {
    expect(looksLikeSelector('#search')).toBe(true);
    expect(looksLikeSelector('.btn-primary')).toBe(true);
    expect(looksLikeSelector('input[name="q"]')).toBe(true);
    expect(looksLikeSelector('Sign in')).toBe(false);
    expect(looksLikeSelector('Search the docs')).toBe(false);
  });
});

describe('runBrowserCommand', () => {
  it('opens a bare host as https and reports where it landed', async () => {
    const { page, acted } = fakePage({ title: 'Example Domain' });

    const result = await runBrowserCommand(page, { action: 'navigate', url: 'example.test' });

    expect(result.success).toBe(true);
    expect(acted).toEqual(['goto https://example.test/']);
    expect(result.url).toBe('https://example.test/');
    expect(result.title).toBe('Example Domain');
    expect(result.controls).toEqual(['Search', 'Sign in']);
  });

  it('refuses a scheme a room could not be shown', async () => {
    // The point of the browser is what the room sees, and a screen share of
    // `file:///etc/passwd` is a different kind of event.
    const { page, acted } = fakePage();

    const result = await runBrowserCommand(page, { action: 'navigate', url: 'file:///etc/passwd' });

    expect(result.success).toBe(false);
    expect(acted).toEqual([]);
  });

  it('answers a command with a missing argument instead of throwing', async () => {
    const { page, acted } = fakePage();

    for (const command of [
      { action: 'navigate' as const },
      { action: 'click' as const },
      { action: 'type' as const },
      { action: 'press' as const },
    ]) {
      const result = await runBrowserCommand(page, command);
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/say (which|what)/i);
    }
    expect(acted).toEqual([]);
  });

  it('clicks by the words on the control, through every role it could be', async () => {
    const { page, acted } = fakePage();

    const result = await runBrowserCommand(page, { action: 'click', target: 'Sign in' });

    expect(result.success).toBe(true);
    // One chained locator: the accessible name first, plain text last.
    expect(acted).toEqual([
      'click button:Sign in|link:Sign in|textbox:Sign in|label:Sign in|placeholder:Sign in|text:Sign in',
    ]);
  });

  it('takes the exact control over the one that merely contains the name', async () => {
    // Playwright matches a name as a substring, and a chained locator resolves in
    // document order — so "Sign in" would otherwise click "Sign in with Google".
    const { page, acted } = fakePage({ controls: ['Sign in with Google', 'Sign in'] });

    await runBrowserCommand(page, { action: 'click', target: 'Sign in' });

    expect(acted[0]).not.toMatch(/~/);
  });

  it('falls back to a partial match when no control has that exact name', async () => {
    // The reading cuts a control name at 60 characters, so the model can only ever
    // quote the start of a long one.
    const { page, acted } = fakePage({ controls: ['Sign in with Google'] });

    await runBrowserCommand(page, { action: 'click', target: 'Sign in with' });

    expect(acted[0]).toMatch(/~/);
  });

  it('clicks a CSS selector as a selector', async () => {
    const { page, acted } = fakePage();

    await runBrowserCommand(page, { action: 'click', target: '#submit' });

    expect(acted).toEqual(['click #submit']);
  });

  it('fills a named field, and types at the cursor without one', async () => {
    const { page, acted } = fakePage();

    await runBrowserCommand(page, { action: 'type', target: 'Search', text: 'kubectl' });
    await runBrowserCommand(page, { action: 'type', text: 'kubectl' });

    expect(acted[0]).toMatch(/^fill button:Search\|.* = kubectl$/);
    expect(acted[1]).toBe('type kubectl');
  });

  it('scrolls down by default and up on a negative amount', async () => {
    const { page, acted } = fakePage();

    await runBrowserCommand(page, { action: 'scroll' });
    await runBrowserCommand(page, { action: 'scroll', amount: -400 });

    expect(acted).toEqual(['wheel 600', 'wheel -400']);
  });

  it('cuts the page text to something worth saying out loud', async () => {
    const { page } = fakePage({ body: 'x'.repeat(5_000) });

    const result = await runBrowserCommand(page, { action: 'read' });

    expect(result.text).toHaveLength(2_000);
  });

  it('reports a failed action, with the reading still attached', async () => {
    const { page } = fakePage({ failWith: 'locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting' });

    const result = await runBrowserCommand(page, { action: 'click', target: 'Nowhere' });

    expect(result.success).toBe(false);
    // One line of it, not Playwright's call log.
    expect(result.message).toBe('That click did not work: locator.click: Timeout 10000ms exceeded.');
    expect(result.url).toBe('https://example.test/');
  });
});

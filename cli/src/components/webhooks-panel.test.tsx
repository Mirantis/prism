import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { WebhooksPanel } from './webhooks-panel.js';
import { ApiError, type ApiClient, type WebhookSubscription } from '../api-client.js';

const { mockEditText } = vi.hoisted(() => ({ mockEditText: vi.fn() }));
vi.mock('../editor.js', () => ({
  editText: mockEditText,
  resolveEditor: () => 'test-editor',
}));

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A save or an editor hand-off resolves over several ticks before its frame. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await flush();
}

const TAB = '\t';
const ENTER = '\r';
const RIGHT = '\x1B[C';

/** Ink parses one write per render, so each key needs the render it belongs to. */
async function type(stdin: { write: (data: string) => void }, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    stdin.write(key);
    await flush();
  }
}

const alerts: WebhookSubscription = {
  id: 'wh-1',
  name: 'alerts',
  description: null,
  events: null,
  prompt: 'Alert: {status}',
  deliverTo: 'all',
  deliverOnly: true,
  isActive: true,
  authType: 'token',
};

/** Renders the panel; `order` records each terminal hand-off and the editor run inside it. */
function renderPanel(updateWebhookSubscription = vi.fn()) {
  const api = {
    listWebhookSubscriptions: vi.fn().mockResolvedValue([alerts]),
    updateWebhookSubscription,
  } as unknown as ApiClient;
  const order: string[] = [];
  const suspendInput = async <T,>(fn: () => Promise<T>): Promise<T> => {
    order.push('suspend');
    const result = await fn();
    order.push('resume');
    return result;
  };
  return { ...render(<WebhooksPanel api={api} onClose={vi.fn()} suspendInput={suspendInput} />), order };
}

describe('the terminal webhooks panel', () => {
  beforeEach(() => {
    mockEditText.mockReset();
  });

  it('pauses the selected subscription with space', async () => {
    const update = vi.fn().mockResolvedValue({ ...alerts, isActive: false });
    const { lastFrame, stdin, unmount } = renderPanel(update);
    await flush();
    expect(lastFrame()).toContain('alerts');

    await type(stdin, ' ');
    expect(update).toHaveBeenCalledWith('wh-1', { isActive: false });
    expect(lastFrame()).toContain('✗');
    unmount();
  });

  it('shows a delivery target that a newer runtime added as its stored value', async () => {
    const api = {
      listWebhookSubscriptions: vi.fn().mockResolvedValue([{ ...alerts, deliverTo: 'none' }]),
    } as unknown as ApiClient;
    const { lastFrame, stdin, unmount } = render(
      <WebhooksPanel api={api} onClose={vi.fn()} suspendInput={(fn) => fn()} />,
    );
    await flush();
    expect(lastFrame()).toMatch(/alerts\s+none\s+direct/);

    await type(stdin, ENTER);
    expect(lastFrame()).toContain('‹ none ›');
    unmount();
  });

  it('saves edited fields, with the prompt written in the editor', async () => {
    const update = vi.fn().mockResolvedValue(alerts);
    const { lastFrame, stdin, unmount, order } = renderPanel(update);
    const discard = vi.fn();
    mockEditText.mockImplementation(async () => {
      order.push('edit');
      return { text: 'Fired: {status}\n', changed: true, file: '/tmp/x', discard };
    });
    await flush();

    await type(stdin, ENTER);
    expect(lastFrame()).toContain('Edit webhook alerts');

    // Description, Events, Deliver to (→ Chat), Deliver only (off), Prompt.
    await type(stdin, 'Pager alerts', TAB, 'push', TAB, RIGHT, TAB, ' ', TAB, ' ');
    await settle();
    expect(order).toEqual(['suspend', 'edit', 'resume']);
    expect(mockEditText).toHaveBeenCalledWith('Alert: {status}', { suffix: '.md' });
    expect(lastFrame()).toContain('Fired: {status}');
    expect(discard).not.toHaveBeenCalled();

    await type(stdin, ENTER);
    await settle();
    expect(discard).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith('wh-1', {
      description: 'Pager alerts',
      events: 'push',
      prompt: 'Fired: {status}',
      deliverTo: 'chat',
      deliverOnly: false,
    });
    expect(lastFrame()).toContain('Webhooks');
    unmount();
  });

  it('previews a prompt with its blank lines and counts the rest', async () => {
    const api = {
      listWebhookSubscriptions: vi
        .fn()
        .mockResolvedValue([{ ...alerts, prompt: 'Fired:\n\n{__raw__}\n\nTriage it.\nThen report.' }]),
    } as unknown as ApiClient;
    const { lastFrame, stdin, unmount } = render(
      <WebhooksPanel api={api} onClose={vi.fn()} suspendInput={(fn) => fn()} />,
    );
    await flush();

    await type(stdin, ENTER);
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Fired:\s*│\n│\s+│\n│\s+\{__raw__\}/);
    expect(frame).toContain('… 2 more lines');
    unmount();
  });

  it('names the file that holds the edited prompt when the save fails, and keeps it', async () => {
    const update = vi.fn().mockRejectedValue(new ApiError('offline', 0));
    const { lastFrame, stdin, unmount } = renderPanel(update);
    const discard = vi.fn();
    mockEditText.mockResolvedValue({ text: 'Fired', changed: true, file: '/tmp/p/d.md', discard });
    await flush();

    await type(stdin, ENTER, TAB, TAB, TAB, TAB, ' ');
    await settle();
    await type(stdin, ENTER);
    await settle();
    expect(lastFrame()).toContain('Your edit is kept at /tmp/p/d.md');

    await type(stdin, '\x1B');
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settle();
    expect(lastFrame()).toContain('Webhooks');
    expect(discard).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps the form open and shows the error when the save fails', async () => {
    const update = vi.fn().mockRejectedValue(new ApiError('bad', 400, 'deliverTo must be one of: all'));
    const { lastFrame, stdin, unmount } = renderPanel(update);
    await flush();

    await type(stdin, ENTER, ENTER);
    await settle();
    expect(lastFrame()).toContain('Edit webhook alerts');
    expect(lastFrame()).toContain('deliverTo must be one of: all');
    unmount();
  });
});

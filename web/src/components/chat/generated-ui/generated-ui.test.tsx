// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Viewer } from '@/lib/chat-socket/protocol';
import type { TranscriptMessage } from '@/lib/chat-socket/transcript';
import { isGeneratedUi, type Attachment, type GeneratedUiBlock, type GeneratedUiElement } from '@/types';
import ChatMessage from '../ChatMessage';
import { GeneratedUi } from './generated-ui';

const ADA: Viewer = { id: 'ada-id', name: 'Ada Example' };

const DEPLOYS: GeneratedUiBlock = {
  type: 'generated_ui',
  version: 1,
  id: 'ui-1',
  root: 'summary',
  elements: {
    summary: { type: 'Card', props: { title: 'Deploys this week' }, children: ['chart', 'choose'] },
    chart: {
      type: 'Chart',
      props: { kind: 'bar', title: 'Deploys per day', categories: ['Mon', 'Tue', 'Wed'], series: [{ name: 'prod', values: [3, 5, 2] }] },
    },
    choose: { type: 'Actions', children: ['roll-back', 'keep', 'docs'] },
    'roll-back': { type: 'Button', props: { label: 'Roll back Wednesday', style: 'danger' } },
    keep: { type: 'Button', props: { label: 'Keep it' } },
    docs: { type: 'LinkButton', props: { label: 'Runbook', url: 'https://example.com/runbook' } },
  },
};

const PRESSED: GeneratedUiBlock = { ...DEPLOYS, pressed: { elementId: 'keep', label: 'Keep it', by: { id: 'grace-id', name: 'Grace Example' } } };

/** A block whose root card holds the given elements, in order. */
function cardOf(elements: Record<string, GeneratedUiElement>): GeneratedUiBlock {
  return {
    type: 'generated_ui',
    version: 1,
    id: 'ui-2',
    root: 'root',
    elements: { root: { type: 'Card', children: Object.keys(elements) }, ...elements },
  };
}

const IMAGE: Attachment = { id: 'img-1', filename: 'graph.png', mediaType: 'image/png', sizeBytes: 10, category: 'image', inline: true };

const show = (block: GeneratedUiBlock, viewer: Viewer | undefined = ADA, attachments: Attachment[] | null = null) =>
  render(<GeneratedUi block={block} viewer={viewer} attachments={attachments} />);

const button = (name: string) => screen.getByRole('button', { name });

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('GeneratedUi elements', () => {
  it('draws a card with its title and children in order', () => {
    show(DEPLOYS);
    expect(screen.getByRole('heading', { name: 'Deploys this week' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Deploys per day' })).toBeTruthy();
    const names = screen.getAllByRole('button').map((item) => item.textContent);
    expect(names).toEqual(['Roll back Wednesday', 'Keep it']);
  });

  it('draws headings, Markdown text, notes and dividers', () => {
    show(
      cardOf({
        heading: { type: 'Heading', props: { text: 'Status' } },
        text: { type: 'Text', props: { text: 'All **green** today.' } },
        line: { type: 'Divider' },
        note: { type: 'Note', props: { text: 'Numbers are from this morning.' } },
      }),
    );
    expect(screen.getByRole('heading', { name: 'Status' })).toBeTruthy();
    expect(screen.getByText('green').tagName).toBe('STRONG');
    expect(screen.getByRole('separator')).toBeTruthy();
    expect(screen.getByRole('note')).toHaveTextContent('Numbers are from this morning.');
  });

  it('draws fields as labels with their values', () => {
    show(cardOf({ fields: { type: 'Fields', props: { fields: [{ label: 'Region', value: 'eu-west-1' }, { label: 'Owner', value: 'Platform' }] } } }));
    const terms = screen.getAllByRole('term').map((term) => term.textContent);
    const values = screen.getAllByRole('definition').map((value) => value.textContent);
    expect(terms).toEqual(['Region', 'Owner']);
    expect(values).toEqual(['eu-west-1', 'Platform']);
  });

  it('draws a table with its header row', () => {
    show(cardOf({ table: { type: 'Table', props: { columns: ['Service', 'State'], rows: [['api', 'up'], ['worker', 'down']] } } }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Service', 'State']);
    expect(within(table).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['api', 'up', 'worker', 'down']);
  });

  it('draws a comparison with one column per option and one row per point', () => {
    show(
      cardOf({
        compare: {
          type: 'Comparison',
          props: { rows: ['Price', 'Speed'], options: [{ title: 'Plan A', values: ['€10', 'fast'] }, { title: 'Plan B', values: ['€20', 'faster'] }] },
        },
      }),
    );
    expect(screen.getByRole('columnheader', { name: 'Plan A' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Plan B' })).toBeTruthy();
    const speed = screen.getByRole('rowheader', { name: 'Speed' }).closest('tr')!;
    expect(within(speed).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['fast', 'faster']);
  });

  it('draws a checklist that says which items are done', () => {
    show(cardOf({ list: { type: 'Checklist', props: { items: [{ text: 'Back up', done: true }, { text: 'Migrate', done: false }] } } }));
    const items = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(items).toEqual(['Back up, done', 'Migrate, not done']);
  });

  it('draws an image from the message’s own attachment', () => {
    show(cardOf({ image: { type: 'Image', props: { attachment: 'attachment:img-1', alt: 'Latency graph' } } }), ADA, [IMAGE]);
    expect(screen.getByRole('img', { name: 'Latency graph' })).toHaveAttribute('src', '/agents/attachments/img-1');
  });

  it('loads no image that is not one of the message’s attachments', () => {
    show(cardOf({ image: { type: 'Image', props: { attachment: 'attachment:other', alt: 'Latency graph' } } }), ADA, [IMAGE]);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Latency graph')).toBeTruthy();
  });

  it('opens a link button in a new tab without the opener', () => {
    show(DEPLOYS);
    const link = screen.getByRole('link', { name: /Runbook/ });
    expect(link).toHaveAttribute('href', 'https://example.com/runbook');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('draws nothing for an element of an unknown type', () => {
    const block = cardOf({
      known: { type: 'Heading', props: { text: 'Shown' } },
      future: { type: 'Map', props: { places: [] } } as unknown as GeneratedUiElement,
    });
    expect(isGeneratedUi(block)).toBe(true);
    show(block);
    expect(screen.getByRole('heading', { name: 'Shown' })).toBeTruthy();
    expect(screen.getByTestId('generated-ui').textContent).toBe('Shown');
  });
});

describe('GeneratedUi presses', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('sends the pressed element id and shows the pressed block the route returns', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(200, { ui: { ...PRESSED, pressed: { ...PRESSED.pressed!, by: ADA } } }));
    show(DEPLOYS);
    fireEvent.click(button('Keep it'));
    await waitFor(() => expect(screen.getByTestId('generated-ui-pressed')).toHaveTextContent('Pressed by you'));
    expect(fetch).toHaveBeenCalledWith('/agents/generated-ui/ui-1/press', expect.objectContaining({ method: 'POST', body: JSON.stringify({ elementId: 'keep' }) }));
    expect(button('Keep it')).toBeDisabled();
    expect(button('Keep it')).toHaveAccessibleDescription('Pressed by you');
    expect(button('Roll back Wednesday')).toBeDisabled();
    expect(button('Roll back Wednesday')).not.toHaveAccessibleDescription();
    expect(screen.getByRole('link', { name: /Runbook/ })).not.toHaveAttribute('aria-disabled');
  });

  it('disables every button while a press is in flight', async () => {
    let finish!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise((resolve) => (finish = resolve)));
    show(DEPLOYS);
    fireEvent.click(button('Roll back Wednesday'));
    expect(button('Roll back Wednesday')).toBeDisabled();
    expect(button('Keep it')).toBeDisabled();
    expect(screen.getByTestId('generated-ui')).toHaveAttribute('aria-busy', 'true');
    await act(async () => finish(answer(200, { ui: PRESSED })));
    expect(screen.getByTestId('generated-ui')).toHaveAttribute('aria-busy', 'false');
  });

  it('shows the stored block when another press was first', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(409, { error: 'already pressed', ui: PRESSED }));
    show(DEPLOYS);
    fireEvent.click(button('Roll back Wednesday'));
    await waitFor(() => expect(screen.getByTestId('generated-ui-pressed')).toHaveTextContent('Pressed by Grace Example'));
    expect(button('Keep it')).toHaveAccessibleDescription('Pressed by Grace Example');
    expect(button('Roll back Wednesday')).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the reply is delayed when the press is stored for later', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(202, { ui: PRESSED, replyPending: true }));
    show(DEPLOYS);
    fireEvent.click(button('Keep it'));
    expect(await screen.findByText('Your choice is saved. The reply is delayed.')).toBeTruthy();
  });

  it('keeps the buttons and says so when the press fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    show(DEPLOYS);
    fireEvent.click(button('Keep it'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Check your connection');
    expect(button('Keep it')).toBeEnabled();
  });

  it('asks for a reload when the block is gone', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer(404, { error: 'not found' }));
    show(DEPLOYS);
    fireEvent.click(button('Keep it'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Reload the page');
  });
});

describe('GeneratedUi pressed state', () => {
  it('names the person who pressed', () => {
    show(PRESSED);
    expect(screen.getByTestId('generated-ui-pressed')).toHaveTextContent('Pressed by Grace Example');
    expect(screen.getAllByRole('button').every((item) => (item as HTMLButtonElement).disabled)).toBe(true);
  });

  it('says Pressed alone when the person is not known', () => {
    show({ ...PRESSED, pressed: { ...PRESSED.pressed!, by: null } });
    expect(screen.getByTestId('generated-ui-pressed').textContent).toBe('Pressed');
  });

  it('shows a press that arrives over the socket as a new copy of the block', () => {
    const view = show(DEPLOYS);
    expect(button('Keep it')).toBeEnabled();
    view.rerender(<GeneratedUi block={PRESSED} viewer={ADA} attachments={null} />);
    expect(button('Keep it')).toBeDisabled();
    expect(screen.getByTestId('generated-ui-pressed')).toHaveTextContent('Pressed by Grace Example');
  });
});

describe('isGeneratedUi', () => {
  it('accepts the contract’s example', () => {
    expect(isGeneratedUi(DEPLOYS)).toBe(true);
    expect(isGeneratedUi(PRESSED)).toBe(true);
  });

  it.each([
    ['another version', { ...DEPLOYS, version: 2 }],
    ['a missing root', { ...DEPLOYS, root: 'nowhere' }],
    ['a missing child', { ...DEPLOYS, elements: { ...DEPLOYS.elements, choose: { type: 'Actions', children: ['gone'] } } }],
    ['a child drawn twice', { ...DEPLOYS, elements: { ...DEPLOYS.elements, choose: { type: 'Actions', children: ['keep', 'keep'] } } }],
    ['a cycle', { ...DEPLOYS, elements: { ...DEPLOYS.elements, summary: { type: 'Card', children: ['summary'] } } }],
    ['a heading that is not text', { ...DEPLOYS, root: 'h', elements: { h: { type: 'Heading', props: { text: { a: 1 } } } } }],
    ['a link that is not https', { ...DEPLOYS, root: 'l', elements: { l: { type: 'LinkButton', props: { label: 'Go', url: 'javascript:alert(1)' } } } }],
    [
      'a series with too few values',
      {
        ...DEPLOYS,
        root: 'c',
        elements: { c: { type: 'Chart', props: { kind: 'bar', title: 'T', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] } } },
      },
    ],
    ['a press with no label', { ...DEPLOYS, pressed: { elementId: 'keep', by: null } }],
    ['null', null],
  ])('refuses %s', (_name, value) => {
    expect(isGeneratedUi(value)).toBe(false);
  });
});

describe('ChatMessage with a generated UI', () => {
  const message = (blocks: unknown[]): TranscriptMessage => ({
    id: 'message-1',
    threadId: 'thread-1',
    role: 'AGENT',
    content: 'The UI as plain text.',
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: blocks as TranscriptMessage['blocks'],
    isCompacted: false,
    createdAt: '2026-11-08T08:38:51.086Z',
    attachments: null,
    senderId: null,
    senderName: null,
  });
  const renderMessage = (blocks: unknown[]) =>
    render(<ChatMessage message={message(blocks)} agentName="Prism" viewer={ADA} onOpenComputerHelp={vi.fn()} onRetry={vi.fn()} onEdit={vi.fn()} />);

  it('draws the block in place of the text', () => {
    renderMessage([DEPLOYS]);
    expect(screen.getByTestId('generated-ui')).toBeTruthy();
    expect(screen.queryByText('The UI as plain text.')).toBeNull();
  });

  it('shows the text for a block of another version', () => {
    renderMessage([{ ...DEPLOYS, version: 2 }]);
    expect(screen.queryByTestId('generated-ui')).toBeNull();
    expect(screen.getByText('The UI as plain text.')).toBeTruthy();
  });

  it('shows the text for a malformed block', () => {
    renderMessage([{ type: 'generated_ui', version: 1, id: 'x', root: 'a', elements: {} }]);
    expect(screen.queryByTestId('generated-ui')).toBeNull();
    expect(screen.getByText('The UI as plain text.')).toBeTruthy();
  });
});

import React from 'react';
import { stripVTControlCharacters } from 'node:util';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { MessageList } from './MessageList.js';
import type { ChatEntry } from '../transcript.js';
import type { TuiMessage } from '../tui-adapter.js';
import { formatShellRecord } from '../shell-command.js';
import type { TerminalGraphics } from '../images/terminal-graphics.js';

const TEXT_ONLY: TerminalGraphics = { protocol: 'text', cell: null };

// A two-by-two white picture stands in for every downloaded attachment.
vi.mock('../images/attachment-images.js', () => ({
  loadAttachmentImage: async () => ({ width: 2, height: 2, data: new Uint8Array(16).fill(255) }),
}));

function makeMsg(overrides: Partial<TuiMessage> & { id: string; role: TuiMessage['role']; content: string }): TuiMessage {
  return {
    threadId: 't1',
    triggeredBy: 'USER_INPUT',
    toolCalls: null,
    blocks: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function entry(m: TuiMessage): ChatEntry {
  return { kind: 'message', message: m };
}

describe('MessageList', () => {
  it('renders nothing visible for an empty entry list', () => {
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={[]} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    expect(lastFrame() ?? '').toBe('');
  });

  it('shows a shell command record as the command, its exit code and its output', () => {
    const content = formatShellRecord({ command: 'aws sso login', exitCode: 1, output: 'Token expired' });
    const entries = [entry(makeMsg({ id: 'u1', role: 'USER', content }))];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('! aws sso login');
    expect(frame).toContain('exit code 1');
    expect(frame).toContain('Token expired');
    expect(frame).not.toContain('<user-shell-command>');
  });

  it('labels user messages with "You" and shows the content', () => {
    const entries = [entry(makeMsg({ id: 'u1', role: 'USER', content: 'hi there' }))];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('You');
    expect(frame).toContain('hi there');
  });

  it("labels a message by someone else in the conversation with that person's name", () => {
    // The people of the recorded session in src/protocol/fixtures/v2-session.json.
    const entries = [
      entry(makeMsg({ id: 'u1', role: 'USER', content: 'from the web', senderId: 'ada@example.com', senderName: 'ada@example.com' })),
      entry(makeMsg({ id: 'u2', role: 'USER', content: 'from here', senderId: 'grace@example.com', senderName: 'grace@example.com' })),
    ];
    const self = { id: 'grace@example.com', name: 'grace@example.com' };
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={self} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▌ ada@example.com');
    expect(frame).toContain('▌ You');
    expect(frame).not.toContain('▌ grace@example.com');
  });

  it('labels every message You until the runtime says who this terminal is', () => {
    const entries = [
      entry(makeMsg({ id: 'u1', role: 'USER', content: 'mine', senderId: 'grace@example.com', senderName: 'grace@example.com' })),
    ];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    expect(lastFrame() ?? '').toContain('▌ You');
    expect(lastFrame() ?? '').not.toContain('grace@example.com');
  });

  it("labels another agent's message with that agent's name, and a notice with its sender's", () => {
    const fromAgent = { role: 'USER' as const, triggeredBy: 'AGENT_MESSAGE' };
    const entries = [
      entry(makeMsg({ ...fromAgent, id: 'a1', content: 'Is CI green?', senderId: 'agent-r', senderName: 'Researcher' })),
      entry(makeMsg({ ...fromAgent, id: 'a2', content: 'Writer did not answer.', senderId: 'messaging', senderName: 'Messaging', agentMessageKind: 'notice' })),
    ];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('▌ Researcher · Agent');
    expect(frame).toContain('▌ Messaging');
    expect(frame).not.toContain('▌ You');
  });

  it('says why a message was not sent', () => {
    const entries: ChatEntry[] = [
      { ...entry(makeMsg({ id: 'u1', role: 'USER', content: 'hello' })), local: true, failed: 'There is no such conversation.' },
    ];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    expect(lastFrame() ?? '').toContain('✗ not sent: There is no such conversation.');
  });

  it('renders a 📎 suffix line for messages with attachments', () => {
    const entries = [
      entry(
        makeMsg({
          id: 'u2',
          role: 'USER',
          content: 'see attached',
          attachments: [
            { id: 'att-1', filename: 'report.pdf', mediaType: 'application/pdf', sizeBytes: 1258291, category: 'pdf' },
          ],
        }),
      ),
    ];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('see attached');
    expect(frame).toContain('· 📎 report.pdf (1.2 MB)');
  });

  it('renders no attachment line when attachments is null', () => {
    const entries = [entry(makeMsg({ id: 'u3', role: 'USER', content: 'plain', attachments: null }))];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    expect(lastFrame() ?? '').not.toContain('📎');
  });

  it('labels agent messages with the agent name and renders markdown content', () => {
    const entries = [entry(makeMsg({ id: 'a1', role: 'AGENT', content: 'reply text' }))];
    const { lastFrame } = render(
      <MessageList agentName="Bobby" self={undefined} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Bobby');
    expect(frame).toContain('reply text');
  });

  it('summarizes tool calls with a "used <names>" line and a collapse/expand hint', () => {
    const entries = [
      entry(
        makeMsg({
          id: 'a2',
          role: 'AGENT',
          content: 'I ran a command',
          toolCalls: [
            {
              tool: 'shell_exec',
              input: 'echo hi',
              output: 'hi',
              success: true,
              timestamp: new Date(0).toISOString(),
            },
          ],
        }),
      ),
    ];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('used shell_exec');
    expect(frame).toContain('ctrl+o to expand');
  });

  it('says how much of a tool result was cut when the message is expanded', () => {
    const entries = [
      entry(
        makeMsg({
          id: 'a4',
          role: 'AGENT',
          content: 'I read the issue',
          toolCalls: [
            {
              tool: 'atlassian__getJiraIssue',
              input: '{}',
              output: 'head … [INCOMPLETE OUTPUT] … tail',
              success: true,
              timestamp: new Date(0).toISOString(),
              truncated: { totalChars: 500000, keptChars: 30000, omittedChars: 470000 },
            },
          ],
        }),
      ),
    ];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId="a4" graphics={TEXT_ONLY} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('cut');
    expect(frame).toContain('30000');
    expect(frame).toContain('500000');
  });

  it('says nothing about a cut when the result was delivered whole', () => {
    const entries = [
      entry(
        makeMsg({
          id: 'a5',
          role: 'AGENT',
          content: 'I ran a command',
          toolCalls: [
            {
              tool: 'shell_exec',
              input: 'echo hi',
              output: 'hi',
              success: true,
              timestamp: new Date(0).toISOString(),
            },
          ],
        }),
      ),
    ];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId="a5" graphics={TEXT_ONLY} />,
    );
    expect(lastFrame() ?? '').not.toContain('cut');
  });

  it('renders tool-call input/output blocks when the message is expanded', () => {
    const entries = [
      entry(
        makeMsg({
          id: 'a3',
          role: 'AGENT',
          content: 'I ran a command',
          toolCalls: [
            {
              tool: 'shell_exec',
              input: 'echo TOOL_IN',
              output: 'TOOL_OUT',
              success: true,
              timestamp: new Date(0).toISOString(),
            },
          ],
        }),
      ),
    ];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId="a3" graphics={TEXT_ONLY} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('TOOL_IN');
    expect(frame).toContain('TOOL_OUT');
    expect(frame).toContain('ctrl+o to collapse');
  });

  it("draws an image the agent places between the reply's text in a kitty terminal", async () => {
    const id = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
    const entries = [
      entry(
        makeMsg({
          id: 'a5',
          role: 'AGENT',
          content: `PRISMBEFORE\n\n![chart](attachment:${id})\n\nPRISMAFTER`,
          attachments: [
            { id, filename: 'chart.png', mediaType: 'image/png', sizeBytes: 90, category: 'image', inline: true },
          ],
        }),
      ),
    ];
    const { stdout } = render(
      <MessageList
        agentName="Prism"
        self={undefined}
        entries={entries}
        expandedMessageId={null}
        graphics={{ protocol: 'kitty', cell: { width: 1, height: 2 } }}
      />,
    );
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const frame = stdout.frames.filter((f) => !f.startsWith('\x1b_G')).at(-1) ?? '';
    const lines = stripVTControlCharacters(frame).split('\n').map((line) => line.trim());
    const before = lines.indexOf('PRISMBEFORE');
    expect(lines.slice(before, before + 5)).toEqual([
      'PRISMBEFORE',
      '',
      '\u{10EEEE}\u0305\u0305\u{10EEEE}',
      '',
      'PRISMAFTER',
    ]);
  });

  it('keeps the description of an image inside its line in any other terminal', () => {
    const id = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90';
    const entries = [
      entry(
        makeMsg({
          id: 'a6',
          role: 'AGENT',
          content: `See ![chart](attachment:${id}) for May.`,
          attachments: [
            { id, filename: 'chart.png', mediaType: 'image/png', sizeBytes: 90, category: 'image', inline: true },
          ],
        }),
      ),
    ];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} graphics={TEXT_ONLY} />,
    );
    expect(lastFrame() ?? '').toContain('See [image: chart] for May.');
  });
});

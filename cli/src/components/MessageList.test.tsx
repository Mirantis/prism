import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { MessageList } from './MessageList.js';
import type { ChatEntry } from '../transcript.js';
import type { TuiMessage } from '../tui-adapter.js';

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
      <MessageList agentName="Prism" self={undefined} entries={[]} expandedMessageId={null} />,
    );
    expect(lastFrame() ?? '').toBe('');
  });

  it('labels user messages with "You" and shows the content', () => {
    const entries = [entry(makeMsg({ id: 'u1', role: 'USER', content: 'hi there' }))];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} />,
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
      <MessageList agentName="Prism" self={self} entries={entries} expandedMessageId={null} />,
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
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} />,
    );
    expect(lastFrame() ?? '').toContain('▌ You');
    expect(lastFrame() ?? '').not.toContain('grace@example.com');
  });

  it('says why a message was not sent', () => {
    const entries: ChatEntry[] = [
      { ...entry(makeMsg({ id: 'u1', role: 'USER', content: 'hello' })), local: true, failed: 'There is no such conversation.' },
    ];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} />,
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
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('see attached');
    expect(frame).toContain('· 📎 report.pdf (1.2 MB)');
  });

  it('renders no attachment line when attachments is null', () => {
    const entries = [entry(makeMsg({ id: 'u3', role: 'USER', content: 'plain', attachments: null }))];
    const { lastFrame } = render(
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} />,
    );
    expect(lastFrame() ?? '').not.toContain('📎');
  });

  it('labels agent messages with the agent name and renders markdown content', () => {
    const entries = [entry(makeMsg({ id: 'a1', role: 'AGENT', content: 'reply text' }))];
    const { lastFrame } = render(
      <MessageList agentName="Bobby" self={undefined} entries={entries} expandedMessageId={null} />,
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
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId={null} />,
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
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId="a4" />,
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
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId="a5" />,
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
      <MessageList agentName="Prism" self={undefined} entries={entries} expandedMessageId="a3" />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('TOOL_IN');
    expect(frame).toContain('TOOL_OUT');
    expect(frame).toContain('ctrl+o to collapse');
  });
});

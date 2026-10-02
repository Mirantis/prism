// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ToolCallRecord } from '@lensapp/prism-client';
import ChatToolCalls from './ChatToolCalls';

const call = (overrides: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  tool: 'shell_exec',
  input: '{"command":"cat big.json"}',
  output: 'the comment body',
  success: true,
  ...overrides,
});

afterEach(cleanup);

/** Open the group, then the one call inside it. */
function expandAll(): void {
  fireEvent.click(screen.getByText(/tools? used/));
  // `formatToolLabel` spaces and title-cases the raw tool name.
  fireEvent.click(screen.getByText('Shell Exec'));
}

describe('ChatToolCalls', () => {
  it('says how much of a result was cut, and out of how much', () => {
    render(
      <ChatToolCalls
        toolCalls={[
          call({
            output: 'head … [INCOMPLETE OUTPUT] … tail',
            truncated: { totalChars: 500_000, keptChars: 30_000, omittedChars: 470_000 },
          }),
        ]}
      />,
    );
    expandAll();

    expect(screen.getByText(/cut — 30\.0K of 500\.0K chars/)).toBeTruthy();
  });

  it('says nothing about a cut when the result was delivered whole', () => {
    render(<ChatToolCalls toolCalls={[call()]} />);
    expandAll();

    expect(screen.getByText('the comment body')).toBeTruthy();
    expect(screen.queryByText(/cut —/)).toBeNull();
  });

  it('shows the text the agent read, not a JSON envelope', () => {
    // What is stored is the model-facing view, so the inspector shows what the
    // agent actually read rather than the raw payload.
    render(<ChatToolCalls toolCalls={[call({ output: 'line one\nline two' })]} />);
    expandAll();

    expect(screen.getByText(/line one/)).toBeTruthy();
  });
});

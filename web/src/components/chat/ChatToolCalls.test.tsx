// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ToolCallRecord } from '@/types';
import ChatToolCalls from './ChatToolCalls';

const call = (overrides: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  tool: 'shell_exec',
  input: '{"command":"cat big.json"}',
  output: 'the comment body',
  success: true,
  ...overrides,
});

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

  it('lists a program call, not the calls the program made', () => {
    render(
      <ChatToolCalls
        toolCalls={[
          call({ tool: 'run_program', output: '3 files' }),
          call({ parentTool: 'run_program' }),
          call({ parentTool: 'run_program', success: false }),
        ]}
      />,
    );

    expect(screen.getByText('1 tool used')).toBeTruthy();
    expect(screen.queryByText(/failed/)).toBeNull();
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

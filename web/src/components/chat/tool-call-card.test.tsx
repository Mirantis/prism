// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ToolCallRecord } from '@/types';

import ToolCallCard from './tool-call-card';

afterEach(cleanup);

function call(over: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    tool: 'shell_exec',
    input: JSON.stringify({ command: 'ls -la' }),
    output: '"ok"',
    success: true,
    ...over,
  } as ToolCallRecord;
}

/**
 * A JSON output whose pretty-printed form runs past the collapsed view's line
 * limit. An array does that; a single long string would not, because its
 * newlines are escaped inside the JSON text rather than being real ones.
 */
const LONG_JSON = JSON.stringify({
  items: Array.from({ length: 12 }, (_, i) => `line ${i}`),
  exitCode: 0,
});

describe('ToolCallCard', () => {
  it('names the tool and previews its most telling argument', () => {
    render(<ToolCallCard tc={call()} />);

    expect(screen.getByText('Shell Exec')).toBeInTheDocument();
    expect(screen.getByText('ls -la')).toBeInTheDocument();
  });

  it('shows every argument and the output once expanded', () => {
    render(<ToolCallCard tc={call()} />);

    fireEvent.click(screen.getByRole('button', { name: /Shell Exec/ }));

    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.getByText('command:')).toBeInTheDocument();
    expect(screen.getByText('Output')).toBeInTheDocument();
  });

  it('expands the same formatted text the preview was cut from', () => {
    // The preview pretty-prints JSON. Expanding must not fall back to the raw
    // string, or the opened output disagrees with the preview above it.
    render(<ToolCallCard tc={call({ output: LONG_JSON })} />);
    fireEvent.click(screen.getByRole('button', { name: /Shell Exec/ }));

    const pretty = JSON.stringify(JSON.parse(LONG_JSON), null, 2);
    const expand = screen.getByRole('button', { name: /Show full output/ });

    // The count is of the formatted text, which is what expanding then shows.
    expect(expand).toHaveTextContent(`${pretty.length} chars`);

    fireEvent.click(expand);

    expect(screen.getByText(pretty, { collapseWhitespace: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse output' })).toBeInTheDocument();
  });

  it('leaves a non-JSON output as it arrived', () => {
    const plain = Array.from({ length: 12 }, (_, i) => `plain line ${i}`).join('\n');
    render(<ToolCallCard tc={call({ output: plain })} />);
    fireEvent.click(screen.getByRole('button', { name: /Shell Exec/ }));

    fireEvent.click(screen.getByRole('button', { name: /Show full output/ }));

    expect(screen.getByText(plain, { collapseWhitespace: false })).toBeInTheDocument();
  });

  it('offers no expand control for an output that fits', () => {
    render(<ToolCallCard tc={call({ output: '"ok"' })} />);
    fireEvent.click(screen.getByRole('button', { name: /Shell Exec/ }));

    expect(screen.queryByRole('button', { name: /Show full output/ })).not.toBeInTheDocument();
  });

  it('says so when a failed call produced no output at all', () => {
    render(<ToolCallCard tc={call({ success: false, output: '' })} />);
    fireEvent.click(screen.getByRole('button', { name: /Shell Exec/ }));

    expect(screen.getByText('Tool execution failed')).toBeInTheDocument();
  });

  it('renders the caller-supplied meta on the trigger row', () => {
    render(<ToolCallCard tc={call()} meta={<span>2m ago</span>} />);

    expect(screen.getByText('2m ago')).toBeInTheDocument();
  });
});

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Input } from './Input.js';

describe('Input', () => {
  it('renders the prompt glyph and the current value', () => {
    const { lastFrame } = render(
      <Input value="hello" onChange={vi.fn()} onSubmit={vi.fn()} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('›');
    expect(frame).toContain('hello');
  });

  it('stays live while the agent is responding', () => {
    // The composer has no disabled state: a draft typed mid-turn has to reach the
    // running turn, which is what makes steering possible from the terminal. The
    // in-flight spinner lives in SpinnerRow, above this box.
    const { lastFrame, stdin } = render(
      <Input value="mid-turn" onChange={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(lastFrame() ?? '').toContain('mid-turn');
    // And the frame carries no in-flight indicator of its own.
    expect(lastFrame() ?? '').not.toContain('thinking');
    expect(stdin).toBeDefined();
  });

  it('reports typed characters through onChange', () => {
    const onChange = vi.fn();
    const { stdin } = render(
      <Input value="" onChange={onChange} onSubmit={vi.fn()} />,
    );

    stdin.write('x');

    expect(onChange).toHaveBeenCalledWith('x');
  });

  it('submits the current value on Enter', () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <Input value="ship it" onChange={vi.fn()} onSubmit={onSubmit} />,
    );

    stdin.write('\r');

    expect(onSubmit).toHaveBeenCalledWith('ship it');
  });

  it('respects hideCursor (no crash; renders the value)', () => {
    const { lastFrame } = render(
      <Input value="abc" onChange={vi.fn()} onSubmit={vi.fn()} hideCursor />,
    );
    expect(lastFrame() ?? '').toContain('abc');
  });
});

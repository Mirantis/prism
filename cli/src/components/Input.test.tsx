import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Input } from './Input.js';

// Ink commits the cursor move before the next key reads it.
const press = async (stdin: { write: (data: string) => void }, ...keys: string[]) => {
  for (const key of keys) {
    stdin.write(key);
    await new Promise((r) => setImmediate(r));
  }
};

// The cursor starts at the end of `value`. After `keys`, an `X` is typed, and the
// value it gives shows where the cursor was.
const typeAfter = async (value: string, keys: string[]) => {
  const onChange = vi.fn();
  const { stdin, unmount } = render(
    <Input value={value} onChange={onChange} onSubmit={vi.fn()} />,
  );
  await press(stdin, ...keys, 'X');
  unmount();
  return onChange.mock.calls.at(-1)?.[0];
};

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

  describe('cursor', () => {
    it('stays at the start when Left is pressed there', async () => {
      const left = '\x1b[D';
      expect(await typeAfter('abc', [left, left, left, left])).toBe('Xabc');
    });

    it('keeps the cursor after the text it inserts', async () => {
      const onChange = vi.fn();
      const Harness = () => {
        const [value, setValue] = useState('');
        return (
          <Input
            value={value}
            onChange={(next) => {
              onChange(next);
              setValue(next);
            }}
            onSubmit={vi.fn()}
          />
        );
      };
      const { stdin, unmount } = render(<Harness />);
      await press(stdin, 'one', '\n', 'two');
      expect(onChange).toHaveBeenLastCalledWith('one\ntwo');
      unmount();
    });
  });

  describe('editing keys', () => {
    // Home, xterm app-cursor Home, vt220 Home, rxvt Home, Ctrl+A, and Cmd+Left
    // as xterm and kitty encode the super modifier.
    it.each(['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~', '\x01', '\x1b[1;9D'])(
      'moves to the start of the line on %j',
      async (key) => {
        expect(await typeAfter('one\ntwo', [key])).toBe('one\nXtwo');
      },
    );

    it.each(['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~', '\x05', '\x1b[1;9C'])(
      'moves to the end of the line on %j',
      async (key) => {
        const left = '\x1b[D';
        expect(await typeAfter('hello world', [left, left, left, key])).toBe('hello worldX');
      },
    );

    // Option+Left as xterm encodes Alt, Meta+B, Option+Left from an Esc+ profile,
    // Ctrl+Left, and rxvt Ctrl+Left.
    it.each(['\x1b[1;3D', '\x1bb', '\x1b\x1b[D', '\x1b[1;5D', '\x1bOd'])(
      'moves back one word on %j',
      async (key) => {
        expect(await typeAfter('hello big world', [key])).toBe('hello big Xworld');
      },
    );

    it.each(['\x1b[1;3C', '\x1bf', '\x1b[1;5C', '\x1bOc'])(
      'moves forward one word on %j',
      async (key) => {
        expect(await typeAfter('hello big world', ['\x1b[H', key])).toBe('helloX big world');
      },
    );

    it('submits on Option+Enter', async () => {
      const onSubmit = vi.fn();
      const onChange = vi.fn();
      const { stdin, unmount } = render(
        <Input value="ship it" onChange={onChange} onSubmit={onSubmit} />,
      );
      await press(stdin, '\x1b\r');
      expect(onSubmit).toHaveBeenCalledWith('ship it');
      expect(onChange).not.toHaveBeenCalled();
      unmount();
    });

    it('leaves the value alone on Ctrl+O, Ctrl+C and Escape', async () => {
      const onChange = vi.fn();
      const { stdin, unmount } = render(
        <Input value="draft" onChange={onChange} onSubmit={vi.fn()} />,
      );
      await press(stdin, '\x0f', '\x03', '\x1b');
      // Ink holds a lone ESC for 20 ms before it emits Escape.
      await new Promise((r) => setTimeout(r, 60));
      expect(onChange).not.toHaveBeenCalled();
      unmount();
    });
  });
});

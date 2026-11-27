import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { TextInput } from './TextInput.js';

describe('TextInput', () => {
  it('moves by word over the mask, not over the hidden words', async () => {
    const onChange = vi.fn();
    const { stdin, unmount } = render(
      <TextInput value="blue horse!42" mask="•" onChange={onChange} />,
    );
    stdin.write('\x1b[1;3D'); // Option+Left
    await new Promise((r) => setImmediate(r));
    stdin.write('X');
    await new Promise((r) => setImmediate(r));
    // The mask has no word characters, so one word move goes to the start.
    expect(onChange).toHaveBeenLastCalledWith('Xblue horse!42');
    unmount();
  });
});

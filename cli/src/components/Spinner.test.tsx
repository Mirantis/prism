import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import { Spinner } from './Spinner.js';

// The `dots` frames from cli-spinners (MIT). See `THIRD_PARTY_NOTICES`.
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

describe('Spinner', () => {
  it('renders one of the braille frames on initial mount', () => {
    const { lastFrame, unmount } = render(<Spinner />);
    const frame = lastFrame() ?? '';
    const found = BRAILLE_FRAMES.some((c) => frame.includes(c));
    expect(found).toBe(true);
    unmount();
  });
});

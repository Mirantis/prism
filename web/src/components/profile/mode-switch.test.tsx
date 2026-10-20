// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ModeSwitch } from './mode-switch';

describe('ModeSwitch', () => {
  it('is one tab stop, on the chosen option', () => {
    render(<ModeSwitch value="fixed" onChange={() => {}} busy={false} />);

    expect(screen.getByRole('radio', { name: 'Fixed' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('tabindex', '-1');
  });

  it('chooses and focuses the other option on an arrow key', () => {
    const onChange = vi.fn();
    render(<ModeSwitch value="fixed" onChange={onChange} busy={false} />);

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Fixed' }), { key: 'ArrowRight' });

    expect(onChange).toHaveBeenCalledWith('auto');
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveFocus();
  });

  it('flips from the focused option while the stored value stays put', () => {
    const onChange = vi.fn();
    render(<ModeSwitch value="fixed" onChange={onChange} busy={false} />);

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Fixed' }), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Auto' }), { key: 'ArrowRight' });

    expect(onChange.mock.calls).toEqual([['auto'], ['fixed']]);
    expect(screen.getByRole('radio', { name: 'Fixed' })).toHaveFocus();
  });

  it('ignores input while busy and keeps the buttons focusable', () => {
    const onChange = vi.fn();
    render(<ModeSwitch value="fixed" onChange={onChange} busy />);

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Fixed' }), { key: 'ArrowRight' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores a click while busy', () => {
    const onChange = vi.fn();
    render(<ModeSwitch value="fixed" onChange={onChange} busy />);

    screen.getByRole('radio', { name: 'Auto' }).click();

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Auto' })).not.toBeDisabled();
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ChatInput from './ChatInput';

afterEach(cleanup);

const baseProps = {
  value: '',
  onChange: () => {},
  onSend: () => {},
  isPending: false,
  onCancel: () => {},
  connectionStatus: 'connected' as const,
  attachments: [],
  onFilesSelected: () => {},
  onRemoveAttachment: () => {},
};

describe('ChatInput', () => {
  it('shows the send button (not STOP) when not pending', () => {
    render(<ChatInput {...baseProps} isPending={false} />);
    expect(screen.queryByTestId('chat-stop-button')).toBeNull();
    expect(document.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it('swaps in an enabled STOP button while pending', () => {
    render(<ChatInput {...baseProps} isPending />);
    const stop = screen.getByTestId('chat-stop-button');
    expect(stop).toBeInTheDocument();
    expect(stop).toBeEnabled();
    // The submit button is replaced, not just hidden.
    expect(document.querySelector('button[type="submit"]')).toBeNull();
  });

  it('fires onCancel when the STOP button is clicked', () => {
    const onCancel = vi.fn();
    render(<ChatInput {...baseProps} isPending onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('chat-stop-button'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

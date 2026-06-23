// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState, type FormEvent } from 'react';
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

  it('disables STOP when disconnected (cancel cannot reach the runtime)', () => {
    const onCancel = vi.fn();
    render(<ChatInput {...baseProps} isPending connectionStatus="disconnected" onCancel={onCancel} />);
    const stop = screen.getByTestId('chat-stop-button');
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

/**
 * Controlled wrapper mirroring AgentChat: it owns `value` so typing/Tab actually
 * update the input, which is what the slash-command popup reacts to.
 */
function Harness({ onSend = vi.fn() }: { onSend?: (e: FormEvent) => void }) {
  const [value, setValue] = useState('');
  return <ChatInput {...baseProps} value={value} onChange={setValue} onSend={onSend} />;
}

function getTextarea() {
  return screen.getByPlaceholderText('Message your agent...') as HTMLTextAreaElement;
}

describe('ChatInput slash-command popup', () => {
  it('shows the popup listing /skills and /help when "/" is typed', () => {
    render(<Harness />);
    fireEvent.change(getTextarea(), { target: { value: '/' } });
    const popup = screen.getByTestId('command-popup');
    expect(within(popup).getByText('/skills')).toBeInTheDocument();
    expect(within(popup).getByText('/help')).toBeInTheDocument();
  });

  it('filters by prefix as the user types', () => {
    render(<Harness />);
    fireEvent.change(getTextarea(), { target: { value: '/sk' } });
    const items = screen.getAllByTestId('command-popup-item');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('/skills');
  });

  it('hides the popup once a space is typed (arguments mode)', () => {
    render(<Harness />);
    fireEvent.change(getTextarea(), { target: { value: '/skills' } });
    expect(screen.queryByTestId('command-popup')).toBeInTheDocument();
    fireEvent.change(getTextarea(), { target: { value: '/skills ' } });
    expect(screen.queryByTestId('command-popup')).toBeNull();
  });

  it('Tab autocompletes the highlighted command to "<name> " and closes the popup', () => {
    render(<Harness />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: '/sk' } });
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe('/skills ');
    expect(screen.queryByTestId('command-popup')).toBeNull();
  });

  it('ArrowDown moves the selection (aria-selected tracks the highlight)', () => {
    render(<Harness />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: '/' } });
    expect(screen.getAllByTestId('command-popup-item')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    const items = screen.getAllByTestId('command-popup-item');
    expect(items[1]).toHaveAttribute('aria-selected', 'true');
    expect(items[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('Escape dismisses the popup without clearing the input; typing reopens it', () => {
    render(<Harness />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: '/' } });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(screen.queryByTestId('command-popup')).toBeNull();
    expect(ta.value).toBe('/');
    fireEvent.change(ta, { target: { value: '/s' } });
    expect(screen.queryByTestId('command-popup')).toBeInTheDocument();
  });

  it('Enter submits (dispatch lives in the parent) even with the popup open', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: '/skills' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });
});

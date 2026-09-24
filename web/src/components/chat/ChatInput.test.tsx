// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useState, type FormEvent } from 'react';
import ChatInput from './ChatInput';
import type { Dictation } from '@/hooks/use-dictation';

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
  contextUsage: null,
};

const usage = {
  threadId: 'thread-1',
  modelId: 'us.anthropic.claude-opus-5',
  usedTokens: 580_000,
  windowTokens: 1_000_000,
  usedPercent: 58,
};

describe('ChatInput', () => {
  it('shows the send button (not STOP) when not pending', () => {
    render(<ChatInput {...baseProps} isPending={false} />);
    expect(screen.queryByTestId('chat-stop-button')).toBeNull();
    expect(document.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it('adds STOP next to a still-enabled send button while pending', () => {
    // The composer stays usable for the whole turn: a message sent now is
    // handed to the running turn (steering), so send must not be replaced.
    render(<ChatInput {...baseProps} value="hi" isPending />);
    const stop = screen.getByTestId('chat-stop-button');
    expect(stop).toBeEnabled();
    expect(document.querySelector('button[type="submit"]')).toBeEnabled();
  });

  it('sends on Enter while the agent is responding', () => {
    const onSend = vi.fn();
    render(<ChatInput {...baseProps} value="change of plan" isPending onSend={onSend} />);
    fireEvent.keyDown(screen.getByPlaceholderText('Message your agent...'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('still disables send on an empty composer while pending', () => {
    // Only the isPending term was dropped from the gate — the empty/uploading
    // guards stay, so STOP is not a way to send nothing.
    render(<ChatInput {...baseProps} value="" isPending />);
    expect(document.querySelector('button[type="submit"]')).toBeDisabled();
  });

  it('fires onCancel when the STOP button is clicked', () => {
    const onCancel = vi.fn();
    render(<ChatInput {...baseProps} isPending onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('chat-stop-button'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons when disconnected (neither can reach the runtime)', () => {
    const onCancel = vi.fn();
    render(
      <ChatInput {...baseProps} value="hi" isPending connectionStatus="disconnected" onCancel={onCancel} />,
    );
    const stop = screen.getByTestId('chat-stop-button');
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(onCancel).not.toHaveBeenCalled();
    // Send goes too: the parent clears the composer and echoes the message
    // optimistically, so an accepted click on a closed socket would destroy the
    // text and then show it as sent.
    expect(document.querySelector('button[type="submit"]')).toBeDisabled();
  });

  it('says why send is inert while disconnected', () => {
    // The button is icon-only and the connection notice sits in the meta strip,
    // so without a disabled-state tooltip the reason is easy to miss.
    render(<ChatInput {...baseProps} value="hi" connectionStatus="connecting" />);
    expect(document.querySelector('button[type="submit"]')).toHaveAttribute(
      'aria-label',
      'Not connected',
    );
  });

  it('does not send on Enter while disconnected', () => {
    const onSend = vi.fn();
    render(<ChatInput {...baseProps} value="hi" connectionStatus="disconnected" onSend={onSend} />);
    fireEvent.keyDown(screen.getByPlaceholderText('Message your agent...'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('offers no voice message when the surface passes no dictation', () => {
    render(<ChatInput {...baseProps} />);
    expect(screen.queryByTestId('dictation-button')).toBeNull();
  });

  describe('voice message', () => {
    const dictation = (overrides: Partial<Dictation> = {}): Dictation => ({
      status: 'idle',
      levels: [],
      startedAt: null,
      error: null,
      start: vi.fn(),
      send: vi.fn(),
      cancel: vi.fn(),
      handleEvent: vi.fn(),
      ...overrides,
    });

    it('starts a recording from the microphone', () => {
      const d = dictation();
      render(<ChatInput {...baseProps} dictation={d} />);
      fireEvent.click(screen.getByTestId('dictation-button'));
      expect(d.start).toHaveBeenCalledTimes(1);
    });

    it('sits beside send, after STOP, so it does not move when a turn starts', () => {
      render(<ChatInput {...baseProps} isPending dictation={dictation()} />);
      const order = Array.from(document.querySelectorAll('button')).map(
        (b) => b.getAttribute('data-testid') ?? b.getAttribute('type'),
      );
      const stop = order.indexOf('chat-stop-button');
      const mic = order.indexOf('dictation-button');
      const send = order.indexOf('submit');
      expect(stop).toBeLessThan(mic);
      expect(mic).toBe(send - 1);
    });

    it('says why it cannot record while a call holds the microphone', () => {
      render(
        <ChatInput
          {...baseProps}
          dictation={dictation()}
          dictationBlockedReason="End the call to record a voice message"
        />,
      );
      const mic = screen.getByTestId('dictation-button');
      expect(mic).toBeDisabled();
      // On the wrapper, which still takes the pointer while the button is disabled.
      expect(screen.getByTestId('dictation-button-hint')).toHaveAttribute(
        'title',
        'End the call to record a voice message',
      );
      expect(mic).toHaveAttribute('aria-description', 'End the call to record a voice message');
    });

    it('cannot record while disconnected', () => {
      render(<ChatInput {...baseProps} connectionStatus="disconnected" dictation={dictation()} />);
      expect(screen.getByTestId('dictation-button')).toBeDisabled();
    });

    it('puts the recording in the text field\'s place, with discard and send', () => {
      const d = dictation({ status: 'recording', startedAt: Date.now() });
      render(<ChatInput {...baseProps} dictation={d} />);

      expect(screen.getByRole('status')).toHaveTextContent('Recording');
      expect(screen.queryByPlaceholderText('Message your agent...')).toBeNull();
      expect(screen.queryByTestId('dictation-button')).toBeNull();

      fireEvent.click(screen.getByTestId('dictation-send'));
      expect(d.send).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByTestId('dictation-cancel'));
      expect(d.cancel).toHaveBeenCalledTimes(1);
    });

    it('keeps the timer out of what a screen reader announces', () => {
      render(<ChatInput {...baseProps} dictation={dictation({ status: 'recording', startedAt: Date.now() })} />);
      expect(screen.getByRole('status').textContent).toBe('Recording');
    });

    it('moves focus to discard when recording starts, and back to the text field after', () => {
      const idle = dictation();
      const { rerender } = render(<ChatInput {...baseProps} dictation={idle} />);
      rerender(<ChatInput {...baseProps} dictation={dictation({ status: 'recording', startedAt: Date.now() })} />);
      expect(screen.getByTestId('dictation-cancel')).toHaveFocus();
      rerender(<ChatInput {...baseProps} dictation={idle} />);
      expect(screen.getByPlaceholderText('Message your agent...')).toHaveFocus();
    });

    it('waits for the words with send disabled', () => {
      render(<ChatInput {...baseProps} dictation={dictation({ status: 'transcribing' })} />);
      expect(screen.getByTestId('dictation-bar')).toHaveTextContent('Transcribing…');
      expect(screen.getByTestId('dictation-send')).toBeDisabled();
    });

    it('says why a dictation failed', () => {
      render(<ChatInput {...baseProps} dictation={dictation({ error: 'No speech was heard.' })} />);
      expect(screen.getByTestId('dictation-error')).toHaveTextContent('No speech was heard.');
    });
  });

  describe('context meter in the meta strip', () => {
    it('renders nothing when there is no measurement yet', () => {
      // A fresh thread must show no reading at all — "100%" would be a claim the
      // runtime hasn't measured.
      render(<ChatInput {...baseProps} />);
      expect(screen.queryByTestId('context-meter')).toBeNull();
    });

    it('shows the remaining percentage once measured, while connected', () => {
      // The strip used to render only when disconnected; this is the regression
      // guard that it now appears on a healthy connection too.
      render(<ChatInput {...baseProps} contextUsage={usage} />);
      expect(screen.getByTestId('context-meter')).toHaveTextContent('58% context used');
    });

    it('shows the connection notice and the meter together', () => {
      render(<ChatInput {...baseProps} connectionStatus="disconnected" contextUsage={usage} />);
      expect(screen.getByText('Disconnected')).toBeInTheDocument();
      expect(screen.getByTestId('context-meter')).toBeInTheDocument();
    });
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

  it('Enter accepts the highlighted command instead of sending it', () => {
    // A fully typed command name plus one Enter no longer sends: while the popup
    // is open Enter completes the highlighted row, as Tab does. A second Enter
    // (popup closed by the trailing space) sends the line.
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: '/' } });
    fireEvent.keyDown(ta, { key: 'ArrowDown' }); // second row, /plugins
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toBe('/plugins ');
    expect(screen.queryByTestId('command-popup')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter with the popup open inserts a newline instead of completing', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    const ta = getTextarea();
    fireEvent.change(ta, { target: { value: '/sk' } });
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(ta.value).toBe('/sk');
    expect(onSend).not.toHaveBeenCalled();
  });
});

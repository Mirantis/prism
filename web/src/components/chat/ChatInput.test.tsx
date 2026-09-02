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
  contextUsage: null,
  voiceState: 'idle' as const,
  onVoiceStart: () => {},
  onVoiceStop: () => {},
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

  describe('voice call in the meta strip', () => {
    it('shows nothing while there is no call', () => {
      render(<ChatInput {...baseProps} />);
      expect(screen.queryByTestId('voice-call-indicator')).toBeNull();
    });

    it('says the call is live, on a healthy connection', () => {
      // The strip renders on its own for a call: a connected composer with no context
      // reading has nothing else to put in it.
      render(<ChatInput {...baseProps} voiceState="live" />);
      expect(screen.getByTestId('voice-call-indicator')).toHaveTextContent('Voice chat live');
    });

    it('never says recording or transcribing, and shows no timer', () => {
      // Criterion: the interface must not imply a transcript exists.
      render(<ChatInput {...baseProps} voiceState="live" />);
      const text = screen.getByTestId('voice-call-indicator').textContent ?? '';
      expect(text.toLowerCase()).not.toMatch(/record|transcri/);
      expect(text).not.toMatch(/\d/);
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

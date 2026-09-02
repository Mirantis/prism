// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import VoiceCallButton from './voice-call-button';

afterEach(cleanup);

const baseProps = {
  state: 'idle' as const,
  isConnected: true,
  onStart: () => {},
  onStop: () => {},
};

describe('VoiceCallButton', () => {
  it('offers to start a call while there is none', () => {
    const onStart = vi.fn();
    render(<VoiceCallButton {...baseProps} onStart={onStart} />);

    const button = screen.getByTestId('voice-call-button');
    expect(button).toHaveAttribute('aria-label', 'Start a voice chat');
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('ends the call it is in, on the same button', () => {
    // One control for the whole call, which is what docs/voice-chat.md asks a client
    // to offer once a session is live.
    const onStart = vi.fn();
    const onStop = vi.fn();
    render(<VoiceCallButton {...baseProps} state="live" onStart={onStart} onStop={onStop} />);

    const button = screen.getByTestId('voice-call-button');
    expect(button).toHaveAttribute('aria-label', 'End the voice chat');
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('says the call is connecting rather than live', () => {
    // The contract is explicit about this one: an answer is not audio.
    render(<VoiceCallButton {...baseProps} state="connecting" />);
    expect(screen.getByTestId('voice-call-button')).toHaveAttribute(
      'aria-label',
      'Connecting the voice chat…',
    );
  });

  it('never claims to be recording or transcribing', () => {
    // Criterion: the interface must not imply a transcript exists. Nothing about a
    // call is written down.
    for (const state of ['idle', 'starting', 'connecting', 'live', 'ending'] as const) {
      cleanup();
      render(<VoiceCallButton {...baseProps} state={state} />);
      const label = screen.getByTestId('voice-call-button').getAttribute('aria-label') ?? '';
      expect(label.toLowerCase()).not.toMatch(/record|transcri/);
    }
  });

  it('is inert while the chat socket is down, and says why', () => {
    // Signalling rides that socket, so a click could not reach the runtime.
    const onStart = vi.fn();
    render(<VoiceCallButton {...baseProps} isConnected={false} onStart={onStart} />);

    const button = screen.getByTestId('voice-call-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-label', 'Not connected');
    fireEvent.click(button);
    expect(onStart).not.toHaveBeenCalled();
  });
});

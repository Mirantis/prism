// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { VoiceCall } from '@/hooks/use-voice-call';
import VoiceCallControl from './voice-call-control';

function fakeCall(overrides: Partial<VoiceCall> = {}): VoiceCall {
  return {
    status: 'idle',
    hasDesktop: false,
    isSpeaking: false,
    isMuted: false,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    toggleMute: vi.fn(),
    setMuted: vi.fn(),
    setPlaybackMuted: vi.fn(),
    handleEvent: vi.fn(),
    handleAudio: vi.fn(),
    handleComputerAudio: vi.fn(),
    ...overrides,
  };
}

describe('VoiceCallControl', () => {
  it('places a call from a round phone button', () => {
    const c = fakeCall();
    render(<VoiceCallControl call={c} blockedReason={null} />);

    const button = screen.getByRole('button', { name: 'Start voice call' });
    fireEvent.click(button);
    expect(c.start).toHaveBeenCalledTimes(1);
  });

  it('shows why a call cannot start on hover and to a screen reader', () => {
    render(<VoiceCallControl call={fakeCall()} blockedReason="Finish the voice message first" />);

    const button = screen.getByTestId('voice-call-button');
    expect(button).toBeDisabled();
    // On the wrapper, which still takes the pointer while the button is disabled.
    expect(button.parentElement).toHaveAttribute('title', 'Finish the voice message first');
    expect(button).toHaveAttribute('aria-description', 'Finish the voice message first');
  });

  it('turns into the cancel for a call that is connecting, and keeps focus on it', () => {
    const idle = fakeCall();
    const { rerender } = render(<VoiceCallControl call={idle} blockedReason={null} />);
    const button = screen.getByTestId('voice-call-button');
    button.focus();

    const starting = fakeCall({ status: 'starting' });
    rerender(<VoiceCallControl call={starting} blockedReason={null} />);

    const cancel = screen.getByTestId('voice-call-cancel');
    expect(cancel).toBe(button);
    expect(cancel).toHaveFocus();
    fireEvent.click(cancel);
    expect(starting.stop).toHaveBeenCalledTimes(1);
  });

  it('leaves a live call to the bar in the conversation', () => {
    render(<VoiceCallControl call={fakeCall({ status: 'live' })} blockedReason={null} />);

    expect(screen.queryByTestId('voice-call-button')).toBeNull();
    expect(screen.queryByTestId('voice-call-cancel')).toBeNull();
  });

  it('gives focus back to the call button when a call ends', () => {
    const { rerender } = render(<VoiceCallControl call={fakeCall({ status: 'live' })} blockedReason={null} />);

    rerender(<VoiceCallControl call={fakeCall()} blockedReason={null} />);

    expect(screen.getByTestId('voice-call-button')).toHaveFocus();
  });

  it('says why the last call stopped, beside the button that places another', () => {
    render(
      <VoiceCallControl
        call={fakeCall({ error: 'There is already a voice chat running. End that one first.' })}
        blockedReason={null}
      />,
    );

    expect(screen.getByTestId('voice-call-error')).toHaveTextContent('already a voice chat running');
    expect(screen.getByTestId('voice-call-button')).toBeEnabled();
  });

  it('announces the call connecting and ending, and never the timer', () => {
    const { rerender } = render(<VoiceCallControl call={fakeCall()} blockedReason={null} />);

    rerender(<VoiceCallControl call={fakeCall({ status: 'live' })} blockedReason={null} />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Call connected$/);

    rerender(<VoiceCallControl call={fakeCall()} blockedReason={null} />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Call ended$/);
  });

  it('announces why a call that was refused did not connect', () => {
    const { rerender } = render(<VoiceCallControl call={fakeCall({ status: 'starting' })} blockedReason={null} />);

    rerender(
      <VoiceCallControl call={fakeCall({ error: 'The microphone is blocked.' })} blockedReason={null} />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Call ended: The microphone is blocked.');
  });
});

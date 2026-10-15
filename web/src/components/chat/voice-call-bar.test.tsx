// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { VoiceCall } from '@/hooks/use-voice-call';
import VoiceCallBar from './voice-call-bar';

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

describe('VoiceCallBar', () => {
  it('shows nothing without a call', () => {
    render(<VoiceCallBar call={fakeCall()} agentName="Prism" />);
    expect(screen.queryByTestId('voice-call-bar')).toBeNull();
  });

  it('says who is being called while the call connects, and lets it be cancelled', () => {
    const c = fakeCall({ status: 'starting' });
    render(<VoiceCallBar call={c} agentName="Prism" />);

    expect(screen.getByTestId('voice-call-bar')).toHaveTextContent('Calling Prism…');
    expect(screen.queryByTestId('voice-call-indicator')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel voice call' }));
    expect(c.stop).toHaveBeenCalledTimes(1);
  });

  it('shows a live call with its timer, whether the agent is heard, mute and hang up', () => {
    const c = fakeCall({ status: 'live' });
    render(<VoiceCallBar call={c} agentName="Prism" />);

    const bar = screen.getByTestId('voice-call-indicator');
    expect(bar).toHaveTextContent('On a call with Prism');
    expect(bar).toHaveTextContent('0:00');
    expect(bar).toHaveTextContent('Listening');

    fireEvent.click(screen.getByTestId('voice-mute-button'));
    expect(c.toggleMute).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'End voice call' }));
    expect(c.stop).toHaveBeenCalledTimes(1);
  });

  it('says the agent is speaking while it is heard', () => {
    render(<VoiceCallBar call={fakeCall({ status: 'live', isSpeaking: true })} agentName="Prism" />);
    expect(screen.getByTestId('voice-call-speaking')).toHaveTextContent('Speaking');
  });

  it('says the microphone is muted, and marks mute as pressed', () => {
    render(<VoiceCallBar call={fakeCall({ status: 'live', isMuted: true })} agentName="Prism" />);

    expect(screen.getByTestId('voice-call-indicator')).toHaveTextContent("You're muted");
    const mute = screen.getByTestId('voice-mute-button');
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    expect(mute).toHaveAttribute('aria-label', 'Unmute microphone');
  });

  it('takes focus that the header button dropped as the call connected', () => {
    const { rerender } = render(<VoiceCallBar call={fakeCall()} agentName="Prism" />);

    rerender(<VoiceCallBar call={fakeCall({ status: 'live' })} agentName="Prism" />);

    expect(screen.getByRole('button', { name: 'End voice call' })).toHaveFocus();
  });
});

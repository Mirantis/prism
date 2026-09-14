// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ComponentProps } from 'react';
import type { VoiceCall, VoiceCallStatus } from '@/hooks/use-voice-call';
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
};

/**
 * The call as the composer sees it. The hook is tested on its own; here the state it
 * reports is set directly, so each screen a user can be looking at is asserted.
 */
function fakeVoice(overrides: Partial<VoiceCall> = {}): VoiceCall {
  return {
    status: 'idle' as VoiceCallStatus,
    hasDesktop: false,
    handleComputerAudio: () => {},
    isSpeaking: false,
    isMuted: false,
    error: null,
    start: vi.fn(),
    stop: vi.fn(),
    toggleMute: vi.fn(),
    handleEvent: vi.fn(),
    handleAudio: vi.fn(),
    ...overrides,
  };
}

function renderComposer(voice: VoiceCall, props: Partial<ComponentProps<typeof ChatInput>> = {}) {
  render(<ChatInput {...baseProps} {...props} voice={voice} />);
}

describe('the voice chat control', () => {
  it('offers a call in the composer, beside the attach button', () => {
    renderComposer(fakeVoice());

    const button = screen.getByTestId('voice-call-button');
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-label', 'Voice chat');
    // Nothing claims a call is running until one is.
    expect(screen.queryByTestId('voice-call-indicator')).toBeNull();
  });

  it('starts a call when it is pressed', () => {
    const voice = fakeVoice();
    renderComposer(voice);

    fireEvent.click(screen.getByTestId('voice-call-button'));

    expect(voice.start).toHaveBeenCalledTimes(1);
  });

  it('says a call is live and offers the one control that ends it', () => {
    const voice = fakeVoice({ status: 'live' });
    renderComposer(voice);

    expect(screen.getByTestId('voice-call-indicator')).toHaveTextContent('Voice chat live');

    const button = screen.getByTestId('voice-call-button');
    expect(button).toHaveAttribute('aria-label', 'End voice chat');
    fireEvent.click(button);

    expect(voice.stop).toHaveBeenCalledTimes(1);
    expect(voice.start).not.toHaveBeenCalled();
  });

  describe('the mute control', () => {
    it('is offered only while a call runs', () => {
      renderComposer(fakeVoice());
      expect(screen.queryByTestId('voice-mute-button')).toBeNull();

      cleanup();
      renderComposer(fakeVoice({ status: 'live' }));
      expect(screen.getByTestId('voice-mute-button')).toBeEnabled();
    });

    it('mutes the microphone and leaves the call alone', () => {
      const voice = fakeVoice({ status: 'live' });
      renderComposer(voice);

      const button = screen.getByTestId('voice-mute-button');
      expect(button).toHaveAttribute('aria-label', 'Mute microphone');
      expect(button).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(button);

      expect(voice.toggleMute).toHaveBeenCalledTimes(1);
      expect(voice.stop).not.toHaveBeenCalled();
    });

    it('shows a muted microphone as muted, and offers to open it again', () => {
      const voice = fakeVoice({ status: 'live', isMuted: true });
      renderComposer(voice);

      const button = screen.getByTestId('voice-mute-button');
      expect(button).toHaveAttribute('aria-label', 'Unmute microphone');
      expect(button).toHaveAttribute('aria-pressed', 'true');
      // The call is still live, and the control that ends it is still the other one.
      expect(screen.getByTestId('voice-call-indicator')).toHaveTextContent('Voice chat live');
      expect(screen.getByTestId('voice-call-button')).toHaveAttribute(
        'aria-label',
        'End voice chat',
      );

      fireEvent.click(button);
      expect(voice.toggleMute).toHaveBeenCalledTimes(1);
    });
  });

  it('says the call is being set up before it is live', () => {
    renderComposer(fakeVoice({ status: 'starting' }));

    expect(screen.getByTestId('voice-call-indicator')).toHaveTextContent('Starting the voice chat…');
  });

  it('shows when the agent is speaking', () => {
    renderComposer(fakeVoice({ status: 'live', isSpeaking: true }));

    // The only evidence in the browser that the agent's audio arrived at all.
    expect(screen.getByTestId('voice-call-speaking')).toBeInTheDocument();
  });

  it('stops showing the speaking cue between turns', () => {
    renderComposer(fakeVoice({ status: 'live', isSpeaking: false }));

    expect(screen.getByTestId('voice-call-indicator')).toBeInTheDocument();
    expect(screen.queryByTestId('voice-call-speaking')).toBeNull();
  });

  it('cannot start a call while the socket is down, and says why', () => {
    const voice = fakeVoice();
    renderComposer(voice, { connectionStatus: 'disconnected' });

    const button = screen.getByTestId('voice-call-button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Not connected');
    fireEvent.click(button);
    expect(voice.start).not.toHaveBeenCalled();
  });

  describe('every refusal reaches the user as readable text', () => {
    // The three sentences the runtime sends, verbatim. A test that paraphrases them
    // would pass while the screen showed nothing.
    const refusals = [
      ['a second voice chat', 'There is already a voice chat running. End that one first.'],
      [
        'a meeting call already running',
        `I'm in a meeting call right now. That has to end before I can talk here.`,
      ],
      [
        'a session that failed to start',
        'Could not start the voice chat: the model refused the session',
      ],
      // The client owns this one: the runtime never hears about a denied microphone.
      [
        'a denied microphone',
        'The microphone is blocked. Allow it in the browser, then start the call again.',
      ],
    ] as const;

    for (const [name, text] of refusals) {
      it(name, () => {
        renderComposer(fakeVoice({ error: text }));

        expect(screen.getByTestId('voice-call-error')).toHaveTextContent(text);
        // Not a dead button: the refusal is over and the call can be tried again.
        expect(screen.getByTestId('voice-call-button')).toBeEnabled();
        expect(screen.getByTestId('voice-call-button')).toHaveAttribute('aria-label', 'Voice chat');
        expect(screen.queryByTestId('voice-call-indicator')).toBeNull();
      });
    }
  });

  it('leaves the conversation alone', () => {
    // Nothing about a call is written down, so the composer must not look as though a
    // message was sent or failed to arrive.
    const onSend = vi.fn();
    renderComposer(fakeVoice({ status: 'live', isSpeaking: true }), { value: 'and in text', onSend });

    const textarea = screen.getByPlaceholderText('Message your agent...');
    expect(textarea).toBeEnabled();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(document.querySelector('button[type="submit"]')).toBeEnabled();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCallModel, mockConfig } = vi.hoisted(() => ({
  mockCallModel: vi.fn(),
  mockConfig: { openaiRealtimeVoice: 'auto' },
}));

vi.mock('../../../config', () => ({ config: mockConfig }));
vi.mock('../../../logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/model-call', () => ({ callModel: mockCallModel }));
vi.mock('../../../lib/classification', () => ({
  getGateRequest: () => ({ model: 'classifier', providerOptions: {}, samplingParams: { temperature: 0 }, minOutputTokens: 0 }),
}));

import {
  NAME_READING_PROMPT,
  READING_WAIT_MS,
  forgetVoiceReadings,
  readingOfAnswer,
  voiceForAgent,
  warmVoice,
} from '../agent-voice';

/** Answers `text` for every name. */
function answers(text: string): void {
  mockCallModel.mockResolvedValue({ text });
}

describe('voiceForAgent', () => {
  beforeEach(() => {
    forgetVoiceReadings();
    mockCallModel.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    mockConfig.openaiRealtimeVoice = 'auto';
  });

  it('speaks every call with a voice that is set, without reading the name', async () => {
    mockConfig.openaiRealtimeVoice = 'ash';
    expect(await voiceForAgent('Max')).toBe('ash');
    expect(mockCallModel).not.toHaveBeenCalled();
  });

  it('trims the name before reading it', async () => {
    answers('man');
    expect(await voiceForAgent('  Atlas ')).toBe('cedar');
    expect(mockCallModel.mock.calls[0]![1].messages[0].content).toBe('<name>\nAtlas\n</name>');
  });

  it.each([
    ['woman', 'marin'],
    ['man', 'cedar'],
    ['unclear', 'marin'],
  ])('speaks a name read as %s with %s', async (answer, voice) => {
    answers(answer);
    expect(await voiceForAgent('Max')).toBe(voice);
  });

  it('sends the name as data, with the shared prompt, as the agent-voice call', async () => {
    answers('man');
    await voiceForAgent('Max');
    expect(mockCallModel).toHaveBeenCalledWith(
      { purpose: 'agent-voice' },
      expect.objectContaining({
        system: NAME_READING_PROMPT,
        messages: [{ role: 'user', content: '<name>\nMax\n</name>' }],
        experimental_telemetry: { isEnabled: false },
      }),
    );
  });

  it('reads a name once', async () => {
    answers('man');
    await voiceForAgent('Max');
    await voiceForAgent('Max');
    expect(mockCallModel).toHaveBeenCalledTimes(1);
  });

  it('speaks with marin while the name is still being read, and with its voice on the next call', async () => {
    vi.useFakeTimers();
    let answer!: (value: { text: string }) => void;
    mockCallModel.mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    const first = voiceForAgent('Max');
    await vi.advanceTimersByTimeAsync(READING_WAIT_MS);
    expect(await first).toBe('marin');

    answer({ text: 'man' });
    expect(await voiceForAgent('Max')).toBe('cedar');
    expect(mockCallModel).toHaveBeenCalledTimes(1);
  });

  it('speaks with marin when the model fails, and reads the name again next time', async () => {
    mockCallModel.mockRejectedValueOnce(new Error('throttled'));
    expect(await voiceForAgent('Max')).toBe('marin');
    answers('man');
    expect(await voiceForAgent('Max')).toBe('cedar');
    expect(mockCallModel).toHaveBeenCalledTimes(2);
  });

  it('speaks a name outside the rule for names with marin, without reading it', async () => {
    expect(await voiceForAgent('<b>Max</b>')).toBe('marin');
    expect(mockCallModel).not.toHaveBeenCalled();
  });
});

describe('warmVoice', () => {
  beforeEach(() => {
    forgetVoiceReadings();
    mockCallModel.mockReset();
  });

  it('reads a new name ahead of the next call', async () => {
    answers('man');
    warmVoice('Max');
    expect(mockCallModel).toHaveBeenCalledTimes(1);
    expect(await voiceForAgent('Max')).toBe('cedar');
    expect(mockCallModel).toHaveBeenCalledTimes(1);
  });

  it('reads nothing when a voice is set', () => {
    mockConfig.openaiRealtimeVoice = 'ash';
    warmVoice('Max');
    mockConfig.openaiRealtimeVoice = 'auto';
    expect(mockCallModel).not.toHaveBeenCalled();
  });
});

describe('readingOfAnswer', () => {
  it.each([
    ['woman', 'woman'],
    ['Man.', 'man'],
    [' woman\n', 'woman'],
    ['unclear', 'unclear'],
    ['male', 'unclear'],
    ['I think man', 'unclear'],
    ['', 'unclear'],
  ])('reads %j as %s', (answer, reading) => {
    expect(readingOfAnswer(answer)).toBe(reading);
  });
});

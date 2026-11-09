import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCallModel, mockConfig, mockState, mockRealtime } = vi.hoisted(() => ({
  mockCallModel: vi.fn(),
  mockConfig: { openaiRealtimeVoice: 'auto', openaiRealtimeNameVoices: { default: 'marin', man: 'cedar' } },
  mockState: new Map<string, string>(),
  mockRealtime: { configured: true },
}));

vi.mock('../../../config', () => ({ config: mockConfig }));
vi.mock('../../../logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/model-call', () => ({ callModel: mockCallModel }));
vi.mock('../../../lib/classification', () => ({
  getGateRequest: () => ({ model: 'classifier', providerOptions: {}, samplingParams: {}, minOutputTokens: 0 }),
}));
vi.mock('../../meeting/openai-endpoint', () => ({ isRealtimeConfigured: () => mockRealtime.configured }));
vi.mock('../../runtime-state.service', () => ({
  AGENT_VOICE_READINGS: 'agentVoiceReadings',
  runtimeStateService: {
    get: async (key: string) => mockState.get(key) ?? null,
    set: async (key: string, value: string) => {
      mockState.set(key, value);
    },
  },
}));

import { NAME_READING_PROMPT, READING_WAIT_MS, forgetVoiceReadings, readingOfAnswer, voiceForAgent, warmVoice } from '../agent-voice';

/** Answers `text` for every name. */
function answers(text: string): void {
  mockCallModel.mockResolvedValue({ text });
}

/** The readings stored in `runtime_state`. */
function stored(): Record<string, string> {
  return JSON.parse(mockState.get('agentVoiceReadings') ?? '{}');
}

beforeEach(() => {
  forgetVoiceReadings();
  mockState.clear();
  mockCallModel.mockReset();
  mockConfig.openaiRealtimeVoice = 'auto';
  mockRealtime.configured = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('voiceForAgent', () => {
  it('speaks every call with a voice that is set, without reading the name', async () => {
    mockConfig.openaiRealtimeVoice = 'ash';
    expect(await voiceForAgent('Max')).toEqual({ voice: 'ash', source: 'configured' });
    expect(mockCallModel).not.toHaveBeenCalled();
  });

  it.each([
    ['woman', 'marin'],
    ['man', 'cedar'],
    ['unclear', 'marin'],
  ])('speaks a name read as %s with %s', async (answer, voice) => {
    answers(answer);
    expect(await voiceForAgent('Max')).toEqual({ voice, source: 'name' });
  });

  it('sends the name trimmed, as data, with the prompt, as the agent-voice call', async () => {
    answers('man');
    await voiceForAgent('  Max ');
    expect(mockCallModel).toHaveBeenCalledWith(
      { purpose: 'agent-voice' },
      expect.objectContaining({
        system: NAME_READING_PROMPT,
        messages: [{ role: 'user', content: '<name>\nMax\n</name>' }],
        experimental_telemetry: { isEnabled: false },
      }),
    );
  });

  it('reads a name once, and stores the reading', async () => {
    answers('man');
    await voiceForAgent('Max');
    await voiceForAgent('Max');
    expect(mockCallModel).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual({ Max: 'man' });
  });

  it('reads the name again when its stored reading is gone', async () => {
    answers('man');
    await voiceForAgent('Max');
    mockState.clear();
    await voiceForAgent('Max');
    expect(mockCallModel).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual({ Max: 'man' });
  });

  it('keeps both readings when two names are read at once', async () => {
    mockCallModel.mockImplementation(async (_meta, params: { messages: { content: string }[] }) => ({
      text: params.messages[0]!.content.includes('Max') ? 'man' : 'woman',
    }));
    await Promise.all([voiceForAgent('Max'), voiceForAgent('Maya')]);
    expect(stored()).toEqual({ Max: 'man', Maya: 'woman' });
  });

  it('takes a stored reading after a restart, without reading the name again', async () => {
    mockState.set('agentVoiceReadings', JSON.stringify({ Max: 'man' }));
    expect(await voiceForAgent('Max')).toEqual({ voice: 'cedar', source: 'name' });
    expect(mockCallModel).not.toHaveBeenCalled();
  });

  it('reads the name when what is stored cannot be read', async () => {
    mockState.set('agentVoiceReadings', '{not json');
    answers('woman');
    expect(await voiceForAgent('Maya')).toEqual({ voice: 'marin', source: 'name' });
    expect(stored()).toEqual({ Maya: 'woman' });
  });

  it('speaks with the default voice while the name is still being read, and with its voice on the next call', async () => {
    vi.useFakeTimers();
    let answer!: (value: { text: string }) => void;
    mockCallModel.mockReturnValue(new Promise((resolve) => { answer = resolve; }));

    const first = voiceForAgent('Max');
    await vi.advanceTimersByTimeAsync(READING_WAIT_MS);
    expect(await first).toEqual({ voice: 'marin', source: 'fallback' });

    answer({ text: 'man' });
    expect(await voiceForAgent('Max')).toEqual({ voice: 'cedar', source: 'name' });
    expect(mockCallModel).toHaveBeenCalledTimes(1);
  });

  it('speaks with the default voice when the model fails, and reads the name again next time', async () => {
    mockCallModel.mockRejectedValueOnce(new Error('throttled'));
    expect(await voiceForAgent('Max')).toEqual({ voice: 'marin', source: 'fallback' });
    expect(stored()).toEqual({});
    answers('man');
    expect(await voiceForAgent('Max')).toEqual({ voice: 'cedar', source: 'name' });
    expect(mockCallModel).toHaveBeenCalledTimes(2);
  });

  it('speaks a name outside the rule for names with the default voice, without reading it', async () => {
    expect(await voiceForAgent('<b>Max</b>')).toEqual({ voice: 'marin', source: 'fallback' });
    expect(mockCallModel).not.toHaveBeenCalled();
  });
});

describe('warmVoice', () => {
  it('reads a new name ahead of the next call', async () => {
    answers('man');
    warmVoice('Max');
    expect(await voiceForAgent('Max')).toEqual({ voice: 'cedar', source: 'name' });
    expect(mockCallModel).toHaveBeenCalledTimes(1);
  });

  it('reads nothing when a voice is set', () => {
    mockConfig.openaiRealtimeVoice = 'ash';
    warmVoice('Max');
    expect(mockCallModel).not.toHaveBeenCalled();
  });

  it('reads nothing when the agent cannot open a voice session', () => {
    mockRealtime.configured = false;
    warmVoice('Max');
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

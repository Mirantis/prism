/**
 * Reading "is the browser actually listening?" out of `pactl`.
 *
 * This one line of parsing is the only evidence that the agent can be heard which
 * doesn't come from the meeting's own UI — a platform can show a live microphone while
 * the browser never opened a capture device, because those are two different systems.
 * So the failure mode here is a parser that answers "yes" to everything: it would
 * turn the check into a formality and put a silent participant back in the room.
 *
 * The fixtures are real `pactl list short sources` output, not invented shapes.
 */

import { describe, it, expect } from 'vitest';
import { AudioStack, sourceClientName, sourceIsRunning } from '../audio-stack';

/** Tab-separated, as `pactl` writes it — the mic open, the meeting monitor idle. */
const CAPTURING = [
  '0\tmeet_out.monitor\tmodule-null-sink.c\ts16le 1ch 48000Hz\tIDLE',
  '1\tbot_speak.monitor\tmodule-null-sink.c\ts16le 1ch 48000Hz\tRUNNING',
  '2\tbot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tRUNNING',
].join('\n');

describe('sourceIsRunning', () => {
  it('sees the virtual mic being captured', () => {
    expect(sourceIsRunning(CAPTURING, 'bot_mic')).toBe(true);
  });

  it('does not read an idle or suspended source as captured', () => {
    // The bug this whole check exists for, in its purest form: the devices are up,
    // the daemon is healthy, and nothing is listening to the agent.
    const idle = CAPTURING.replace('bot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tRUNNING',
      'bot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tIDLE');
    expect(sourceIsRunning(idle, 'bot_mic')).toBe(false);

    const suspended = CAPTURING.replace('bot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tRUNNING',
      'bot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tSUSPENDED');
    expect(sourceIsRunning(suspended, 'bot_mic')).toBe(false);
  });

  it('does not credit one source with another\'s state', () => {
    // `bot_speak.monitor` is RUNNING in the fixture (our remap reads it) and its name
    // contains the sink's, so a substring match or a wrong field index would read as
    // capture on a source nobody has open.
    const idleMic = CAPTURING.replace('bot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tRUNNING',
      'bot_mic\tmodule-remap-source.c\ts16le 1ch 48000Hz\tIDLE');
    expect(sourceIsRunning(idleMic, 'bot_mic')).toBe(false);
    expect(sourceIsRunning(idleMic, 'bot_speak.monitor')).toBe(true);
  });

  it('reads space-separated output too', () => {
    // Some pactl builds align columns with spaces. The sample spec in the middle
    // ("s16le 1ch 48000Hz") already contains spaces, which is what makes a tab-only
    // split look correct until it silently matches nothing.
    const spaced = CAPTURING.replace(/\t/g, '   ');
    expect(sourceIsRunning(spaced, 'bot_mic')).toBe(true);
  });

  it('answers no for a source that is not there at all', () => {
    // What a renamed module or a daemon that never loaded the remap produces. Absent
    // must not read as fine — that is the reading a broken setup gives.
    expect(sourceIsRunning(CAPTURING, 'bot_microphone')).toBe(false);
    expect(sourceIsRunning('', 'bot_mic')).toBe(false);
  });
});

/**
 * `pactl list source-outputs` from `pactl` 16.1, the image's version: the remap reading
 * `bot_speak.monitor`, our own capture of the speaker, and a call app on the microphone.
 * Trimmed to the fields the parser reads plus a few around them.
 */
const SOURCE_OUTPUTS = `Source Output #0
	Driver: module-remap-source.c
	Owner Module: 3
	Client: n/a
	Source: 1
	Sample Specification: s16le 1ch 48000Hz
	Properties:
		media.name = "Remapped Stream"
		media.role = "filter"

Source Output #1
	Driver: protocol-native.c
	Owner Module: 0
	Client: 4
	Source: 0
	Sample Specification: s16le 2ch 44100Hz
	Properties:
		application.name = "parec"
		media.name = "parec"
		application.process.binary = "pacat"

Source Output #2
	Driver: protocol-native.c
	Owner Module: 0
	Client: 3
	Source: 2
	Sample Specification: s16le 2ch 44100Hz
	Properties:
		application.name = "Slack"
		media.name = "RecordStream"
		application.process.binary = "slack"
`;

describe('sourceClientName', () => {
  it('names the program recording the microphone', () => {
    expect(sourceClientName(CAPTURING, SOURCE_OUTPUTS, 'bot_mic')).toBe('Slack');
  });

  it('does not credit the microphone with a program recording another source', () => {
    // Our own capture of the speaker is a source output too, on index 0.
    const others = SOURCE_OUTPUTS.split('Source Output #2')[0];
    expect(sourceClientName(CAPTURING, others, 'bot_mic')).toBeNull();
    expect(sourceClientName(CAPTURING, SOURCE_OUTPUTS, 'meet_out.monitor')).toBe('parec');
  });

  it('falls back to the binary when a program states no name', () => {
    const unnamed = SOURCE_OUTPUTS.replace('\t\tapplication.name = "Slack"\n', '');
    expect(sourceClientName(CAPTURING, unnamed, 'bot_mic')).toBe('slack');
  });

  it('answers null when the microphone is not in the source list', () => {
    expect(sourceClientName('', SOURCE_OUTPUTS, 'bot_mic')).toBeNull();
  });
});

describe('isMicCaptured', () => {
  it('answers no once the stack is gone, rather than asking a dead daemon', async () => {
    // The mid-call retry asks this every ten seconds for the length of a call, so it can
    // easily outlive one. With the runtime dir nulled, `pactl` would throw — and a throw
    // here reads as "not captured" anyway, so the only thing at stake is whether the
    // answer costs a spawned process. It should not.
    const stack = new AudioStack();
    await stack.stop();

    await expect(stack.isMicCaptured()).resolves.toBe(false);
  });
});

describe('waitForMicCapture', () => {
  it('gives up at once on a stack that has already been torn down', async () => {
    // The wait can outlive the call that started it. With the daemon gone there is
    // nothing left to ask — every `pactl` call would throw on the removed runtime dir —
    // so polling on would spend the whole budget answering a question about a call
    // that is over.
    const stack = new AudioStack();
    await stack.stop();

    const startedAt = Date.now();
    await expect(stack.waitForMicCapture(10_000)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

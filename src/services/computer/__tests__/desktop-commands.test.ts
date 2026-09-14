/**
 * What `DesktopInput` actually writes to `xdotool`, with the process replaced by a sink.
 *
 * The other file covers the reading of a frame; this one covers the commands a frame
 * turns into, and their order — a click that goes out before the movement under it lands
 * somewhere the user did not point at.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

/** Every line written to the fake `xdotool`, in order. */
const written: string[] = [];

vi.mock('child_process', () => ({
  spawn: () => {
    const proc = new EventEmitter() as EventEmitter & { stdin: unknown; kill: () => void };
    proc.stdin = {
      write: (line: string) => {
        written.push(line.trimEnd());
        return true;
      },
      end: () => {},
    };
    proc.kill = () => {};
    return proc;
  },
}));

const { DesktopInput } = await import('../desktop-input');

beforeEach(() => {
  written.length = 0;
});

describe('taking control of the screen', () => {
  it('puts the pointer where the user clicked before the click goes out', () => {
    const input = new DesktopInput({}, { width: 1280, height: 720 });

    // What the page sends when the user clicks the screen to take control: an absolute
    // position, then the button. Nothing moved in between, so there is no movement
    // waiting on the timer to carry the position out.
    input.handle({ type: 'pointer', x: 400, y: 300 });
    input.handle({ type: 'pointer_button', button: 'left', down: true });
    input.handle({ type: 'pointer_button', button: 'left', down: false });

    expect(written).toEqual(['mousemove 400 300', 'mousedown 1', 'mouseup 1']);
    input.stop();
  });

  it('clamps an absolute position to the screen it is on', () => {
    const input = new DesktopInput({}, { width: 1280, height: 720 });

    input.handle({ type: 'pointer', x: 9999, y: -5 });

    expect(written).toEqual(['mousemove 1279 0']);
    input.stop();
  });

  it('drops movement still waiting when the pointer is placed somewhere', () => {
    const input = new DesktopInput({}, { width: 1280, height: 720 });

    // A delta schedules a move for a few milliseconds' time; an absolute position that
    // lands first replaces it rather than being followed by it.
    input.handle({ type: 'pointer_move', dx: 10, dy: 10 });
    input.handle({ type: 'pointer', x: 700, y: 500 });
    input.handle({ type: 'pointer_button', button: 'left', down: true });

    expect(written).toEqual(['mousemove 700 500', 'mousedown 1']);
    expect(input.pointer).toEqual({ x: 700, y: 500 });
    input.stop();
  });

  it('carries the movement gathered so far out in front of a click', async () => {
    const input = new DesktopInput({}, { width: 1280, height: 720 });

    input.handle({ type: 'pointer_move', dx: 100, dy: 50 });
    // Still on the timer at this point, and the click flushes it.
    input.handle({ type: 'pointer_button', button: 'left', down: true });

    expect(written).toEqual(['mousemove 740 410', 'mousedown 1']);
    input.stop();
  });
});

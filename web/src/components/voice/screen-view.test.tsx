// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { ScreenView } from './screen-view';
import type { PageFrame } from '@/hooks/use-computer-screen';

/**
 * The order the page sends the user's hand in.
 *
 * Movement is gathered per animation frame, and everything that acts on where the pointer
 * is has to go out behind it. A click that overtakes a frame's movement lands where the
 * pointer was, and the runtime cannot put the two back in order: it has not been told
 * about the movement yet.
 */

let frames: Array<() => void> = [];

beforeEach(() => {
  frames = [];
  Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
  Object.defineProperty(document, 'exitPointerLock', { value: vi.fn(), configurable: true });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  // jsdom has no layout, so the box reports its size to nobody.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames[handle - 1] = () => {};
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Render the screen with the pointer taken, and hand back what it sent. */
function takeControl(onRelease = vi.fn()) {
  const sent: PageFrame[] = [];
  const screenRef = createRef<HTMLCanvasElement>();
  render(
    <ScreenView
      screenRef={screenRef}
      hasScreen
      controllable
      canTakeControl
      onTakeControl={async () => true}
      onInput={(frame) => sent.push(frame)}
      connecting={false}
      onRelease={onRelease}
    />,
  );
  // The lock is the browser's; the component follows `pointerlockchange`.
  const box = document.querySelector('.aspect-video') as HTMLElement;
  Object.defineProperty(document, 'pointerLockElement', { value: box, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('pointerlockchange'));
  });
  return sent;
}

const move = (movementX: number, movementY: number) =>
  act(() => {
    // jsdom's MouseEvent has movementX/Y as getters only, so they are defined on the
    // instance rather than assigned.
    const event = new MouseEvent('mousemove', { bubbles: true });
    Object.defineProperties(event, {
      movementX: { value: movementX },
      movementY: { value: movementY },
    });
    document.dispatchEvent(event);
  });

const press = () =>
  act(() => {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });

const runFrame = () =>
  act(() => {
    const pending = frames;
    frames = [];
    pending.forEach((cb) => cb());
  });

describe('the pointer while the user holds the screen', () => {
  it('releases pointer lock on Escape without sending the key to the desktop', () => {
    const release = vi.fn();
    const sent = takeControl(release);
    const exit = vi.fn();
    Object.defineProperty(document, 'exitPointerLock', { value: exit, configurable: true });
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(exit).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(sent).toEqual([]);
  });

  it('hands back once when native Escape only emits pointerlockchange', async () => {
    const release = vi.fn();
    takeControl(release);
    Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
    act(() => document.dispatchEvent(new Event('pointerlockchange')));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 110)));
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps human control when focus changes after pointer lock is released', async () => {
    const release = vi.fn();
    takeControl(release);
    Object.defineProperty(document, 'pointerLockElement', { value: null, configurable: true });
    act(() => document.dispatchEvent(new Event('pointerlockchange')));
    act(() => window.dispatchEvent(new Event('blur')));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 110)));
    expect(release).not.toHaveBeenCalled();
  });

  it('keeps human control when the viewer unmounts', () => {
    const release = vi.fn();
    takeControl(release);
    cleanup();
    expect(release).not.toHaveBeenCalled();
  });

  it('sends the movement under a click before the click', () => {
    const sent = takeControl();

    move(30, 20);
    // Inside the same frame: the gathered movement has not gone out yet.
    press();

    expect(sent).toEqual([
      { type: 'pointer_move', dx: 30, dy: 20 },
      { type: 'pointer_button', button: 'left', down: true },
    ]);
  });

  it('does not send that movement twice when the frame comes round', () => {
    const sent = takeControl();

    move(30, 20);
    press();
    runFrame();

    expect(sent.filter((f) => f.type === 'pointer_move')).toHaveLength(1);
  });

  it('sends the movement under a wheel before the wheel', () => {
    const sent = takeControl();

    move(5, 5);
    act(() => {
      document.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }));
    });

    expect(sent).toEqual([
      { type: 'pointer_move', dx: 5, dy: 5 },
      { type: 'wheel', dy: 120 },
    ]);
  });

  it('sends a click on its own when nothing moved', () => {
    const sent = takeControl();

    press();

    expect(sent).toEqual([{ type: 'pointer_button', button: 'left', down: true }]);
  });

  it('gathers a frame of movement into one frame of its own', () => {
    const sent = takeControl();

    move(10, 0);
    move(5, 5);
    runFrame();

    expect(sent).toEqual([{ type: 'pointer_move', dx: 15, dy: 5 }]);
  });
});

describe('clicking to take control', () => {
  function viewer(onTakeControl: () => Promise<boolean>) {
    const onInput = vi.fn();
    const onRelease = vi.fn();
    const screenRef = createRef<HTMLCanvasElement>();
    const props = {
      screenRef,
      hasScreen: true,
      controllable: false,
      canTakeControl: true,
      connecting: false,
      onInput,
      onRelease,
      onTakeControl,
    };
    const view = render(<ScreenView {...props} />);
    const box = screenRef.current!.parentElement!;
    box.requestPointerLock = vi.fn(async () => {
      Object.defineProperty(document, 'pointerLockElement', { value: box, configurable: true });
      document.dispatchEvent(new Event('pointerlockchange'));
    });
    return { box, onInput, onRelease, props, ...view };
  }

  it('waits for ownership before sending input and consumes the first click', async () => {
    let resolve!: (granted: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    const grant = { promise, resolve };
    const acquire = vi.fn(() => grant.promise);
    const view = viewer(acquire);
    await act(async () => fireEvent.click(view.box));
    press();
    expect(acquire).toHaveBeenCalledOnce();
    expect(view.onInput).not.toHaveBeenCalled();
    await act(async () => grant.resolve(true));
    view.rerender(<ScreenView {...view.props} controllable />);
    expect(view.onInput.mock.calls).toEqual([[{ type: 'pointer', x: 0, y: 0 }]]);
    press();
    expect(view.onInput).toHaveBeenLastCalledWith({
      type: 'pointer_button',
      button: 'left',
      down: true,
    });
  });

  it('hands back after Escape during the ownership request', async () => {
    let resolve!: (granted: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    const grant = { promise, resolve };
    const view = viewer(() => grant.promise);
    await act(async () => fireEvent.click(view.box));
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(view.onRelease).not.toHaveBeenCalled();
    await act(async () => grant.resolve(true));
    expect(view.onRelease).toHaveBeenCalledOnce();
    expect(view.onInput).not.toHaveBeenCalled();
  });

  it('releases the local pointer when another viewer wins ownership', async () => {
    const view = viewer(async () => false);
    await act(async () => fireEvent.click(view.box));
    expect(document.exitPointerLock).toHaveBeenCalled();
    expect(view.onInput).not.toHaveBeenCalled();
    expect(view.onRelease).not.toHaveBeenCalled();
  });
});

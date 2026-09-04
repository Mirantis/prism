import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Maximize, Minimize } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InputFrame } from '@/hooks/use-voice-chat';

interface ScreenViewProps {
  /** The image the runtime's pictures are drawn into; owned by the voice chat hook. */
  screenRef: RefObject<HTMLImageElement | null>;
  hasScreen: boolean;
  /** Whether the runtime accepts pointer and keyboard input for this screen. */
  controllable: boolean;
  onInput: (frame: InputFrame) => void;
  /** Laid over the screen, e.g. the agent's tile. */
  children?: ReactNode;
}

const BUTTONS: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' };

/**
 * The agent's screen, and a way to take it over.
 *
 * A click asks the browser for the pointer lock, which hides the page's own cursor and
 * hands over raw mouse movement until the user presses Esc, the browser's own way out
 * of a lock. While locked, movement, buttons, the wheel and every key go to the
 * runtime, which moves the desktop's pointer. The first click only takes control; it
 * is not sent as a click, so taking over cannot press anything by accident.
 *
 * The box can go fullscreen. The picture keeps its shape inside it, so on a monitor of
 * another shape there are bars beside or above it; the pointer maths works from where
 * the picture is drawn, not from the box.
 *
 * With the screen on the page but not under control, a paste types the clipboard text
 * into the desktop, which is how text gets from the user's machine onto it.
 */
export function ScreenView({ screenRef, hasScreen, controllable, onInput, children }: ScreenViewProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [controlling, setControlling] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  /**
   * Where the picture is drawn inside the box, in page pixels, and desktop pixels per
   * page pixel there. `object-contain` centres it and letterboxes the rest.
   */
  const drawn = useCallback((): { left: number; top: number; scale: number } => {
    const box = boxRef.current;
    const img = screenRef.current;
    if (!box || !img || box.clientWidth === 0 || box.clientHeight === 0) return { left: 0, top: 0, scale: 1 };
    const naturalWidth = img.naturalWidth || box.clientWidth;
    const naturalHeight = img.naturalHeight || box.clientHeight;
    const fit = Math.min(box.clientWidth / naturalWidth, box.clientHeight / naturalHeight);
    return {
      left: (box.clientWidth - naturalWidth * fit) / 2,
      top: (box.clientHeight - naturalHeight * fit) / 2,
      scale: 1 / fit,
    };
  }, [screenRef]);

  useEffect(() => {
    const onLock = () => setControlling(document.pointerLockElement === boxRef.current);
    const onFull = () => setFullscreen(document.fullscreenElement === boxRef.current);
    document.addEventListener('pointerlockchange', onLock);
    document.addEventListener('fullscreenchange', onFull);
    return () => {
      document.removeEventListener('pointerlockchange', onLock);
      document.removeEventListener('fullscreenchange', onFull);
      if (document.pointerLockElement === boxRef.current) document.exitPointerLock();
      if (document.fullscreenElement === boxRef.current) void document.exitFullscreen();
    };
  }, []);

  useEffect(() => {
    if (!controlling) return;

    // Movement is gathered per animation frame; the runtime gathers again on its side.
    let dx = 0;
    let dy = 0;
    let flush: number | null = null;
    const onMove = (e: globalThis.MouseEvent) => {
      const { scale } = drawn();
      dx += e.movementX * scale;
      dy += e.movementY * scale;
      if (flush !== null) return;
      flush = requestAnimationFrame(() => {
        flush = null;
        if (dx === 0 && dy === 0) return;
        onInput({ type: 'pointer_move', dx, dy });
        dx = 0;
        dy = 0;
      });
    };
    const onButton = (down: boolean) => (e: globalThis.MouseEvent) => {
      e.preventDefault();
      const button = BUTTONS[e.button];
      if (button) onInput({ type: 'pointer_button', button, down });
    };
    const onDown = onButton(true);
    const onUp = onButton(false);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY !== 0) onInput({ type: 'wheel', dy: e.deltaY });
    };
    const onKey = (e: KeyboardEvent) => {
      // Esc ends the lock; the browser handles it, and the desktop never sees it.
      if (e.key === 'Escape') return;
      e.preventDefault();
      onInput({
        type: 'key',
        key: e.key,
        code: e.code,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
        meta: e.metaKey,
      });
    };
    const swallow = (e: Event) => e.preventDefault();

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKey);
    document.addEventListener('contextmenu', swallow);
    return () => {
      if (flush !== null) cancelAnimationFrame(flush);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('wheel', onWheel);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('contextmenu', swallow);
    };
  }, [controlling, onInput, drawn]);

  // Outside control, a paste on the page types the clipboard text into whatever has focus
  // on the desktop. Inside control the keys go through as they are, so Cmd+V or Ctrl+V
  // pastes the desktop's own clipboard.
  useEffect(() => {
    if (!controllable || !hasScreen || controlling) return;
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (!text) return;
      e.preventDefault();
      onInput({ type: 'text', text });
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [controllable, hasScreen, controlling, onInput]);

  const takeControl = (e: MouseEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    if (!box || !controllable || !hasScreen || controlling) return;
    // Put the desktop's pointer where the hand is, then let the deltas move it from there.
    const rect = box.getBoundingClientRect();
    const { left, top, scale } = drawn();
    onInput({
      type: 'pointer',
      x: (e.clientX - rect.left - left) * scale,
      y: (e.clientY - rect.top - top) * scale,
    });
    box.requestPointerLock();
  };

  const toggleFullscreen = (e: MouseEvent<HTMLButtonElement>) => {
    // Not a click on the screen: it must not take the pointer.
    e.stopPropagation();
    const box = boxRef.current;
    if (!box) return;
    if (document.fullscreenElement === box) void document.exitFullscreen();
    else void box.requestFullscreen();
  };

  const canTake = controllable && hasScreen && !controlling;

  return (
    <div
      ref={boxRef}
      onClick={takeControl}
      className={cn(
        'relative aspect-video w-full overflow-hidden rounded-lg bg-black select-none',
        canTake && 'cursor-pointer',
      )}
    >
      <img
        ref={screenRef}
        alt="The agent's screen"
        draggable={false}
        className={cn('h-full w-full object-contain', !hasScreen && 'invisible')}
      />
      {!hasScreen && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
          Starting the agent's screen…
        </p>
      )}
      {controlling && (
        <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-sky-500/90 px-4 py-1.5 text-sm font-medium text-white shadow">
          You control the screen · press <kbd className="rounded bg-white/20 px-1.5">Esc</kbd> to stop
        </div>
      )}
      {hasScreen && (
        <div className="absolute right-3 top-3 flex items-center gap-2">
          {canTake && (
            <p className="rounded-md bg-black/50 px-2 py-1 text-xs text-zinc-300">
              Click to control the screen · paste types into it
            </p>
          )}
          <button
            type="button"
            aria-label={fullscreen ? 'Exit fullscreen' : 'Open fullscreen'}
            onClick={toggleFullscreen}
            className="flex size-7 cursor-pointer items-center justify-center rounded-md bg-black/50 text-zinc-300 hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from 'react';
import { Maximize, Minimize, Monitor, LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InputFrame, VoiceChatState } from '@/hooks/use-voice-chat';

interface ScreenViewProps {
  /** The image the runtime's pictures are drawn into; owned by the voice chat hook. */
  screenRef: RefObject<HTMLCanvasElement | null>;
  hasScreen: boolean;
  state: VoiceChatState;
  /**
   * The size of this box in device pixels, whenever it changes.
   *
   * The runtime makes the agent's screen this size, so the picture arrives at the size it
   * is drawn and nothing is scaled on the way. Reported at once the first time, since the
   * call waits for it, and settled afterwards so a window being dragged does not resize a
   * desktop on every frame.
   */
  onViewport?: (size: { width: number; height: number }) => void;
  /** Whether the runtime accepts pointer and keyboard input for this screen. */
  controllable: boolean;
  onInput: (frame: InputFrame) => void;
  /** Laid over the screen, e.g. the agent's tile. */
  children?: ReactNode;
}

const BUTTONS: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' };

/** How long the box has to stop changing before its new size is reported. */
const VIEWPORT_SETTLE_MS = 250;

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
export function ScreenView({
  screenRef,
  hasScreen,
  state,
  controllable,
  onInput,
  onViewport,
  children,
}: ScreenViewProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [controlling, setControlling] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Measured from the box itself rather than the window, so the sidebar, the page's
  // padding and fullscreen are all already accounted for.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !onViewport) return;
    let settle: number | null = null;
    let reported = false;

    const measure = () => {
      const { width, height } = box.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      const ratio = window.devicePixelRatio || 1;
      onViewport({ width: Math.round(width * ratio), height: Math.round(height * ratio) });
    };
    const report = () => {
      // The first measurement opens the call, so it does not wait.
      if (!reported) {
        reported = true;
        measure();
        return;
      }
      if (settle !== null) clearTimeout(settle);
      settle = window.setTimeout(measure, VIEWPORT_SETTLE_MS);
    };

    const observer = new ResizeObserver(report);
    observer.observe(box);
    // A window moved to a display of another density changes the pixels without changing
    // the box, and the observer says nothing about that.
    window.addEventListener('resize', report);
    return () => {
      if (settle !== null) clearTimeout(settle);
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [onViewport]);

  /**
   * Where the picture is drawn inside the box, in page pixels, and desktop pixels per
   * page pixel there. `object-contain` centres it and letterboxes the rest.
   */
  const drawn = useCallback((): { left: number; top: number; scale: number } => {
    const box = boxRef.current;
    const screen = screenRef.current;
    if (!box || !screen || box.clientWidth === 0 || box.clientHeight === 0) {
      return { left: 0, top: 0, scale: 1 };
    }
    const naturalWidth = screen.width || box.clientWidth;
    const naturalHeight = screen.height || box.clientHeight;
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
        'relative aspect-video w-full overflow-hidden bg-zinc-950 select-none',
        canTake && 'cursor-pointer',
      )}
    >
      <canvas
        ref={screenRef}
        aria-label="The agent's screen"
        className={cn('h-full w-full object-contain', !hasScreen && 'invisible')}
      />
      {!hasScreen && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl border border-white/10 bg-zinc-900 text-zinc-400">
            {state === 'connecting' || state === 'ready'
              ? <LoaderCircle className="size-6 motion-safe:animate-spin" />
              : <Monitor className="size-6" />}
          </div>
          <p className="text-sm font-medium text-zinc-200">
            {state === 'connecting' || state === 'ready' ? 'Preparing your computer' : 'Computer unavailable'}
          </p>
          <p className="max-w-xs text-xs leading-5 text-zinc-400">
            {state === 'connecting' || state === 'ready'
              ? "The agent’s screen will appear here when it is ready."
              : 'Check the connection status above for details.'}
          </p>
        </div>
      )}
      {controlling && (
        <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-sky-500/90 px-4 py-1.5 text-sm font-medium text-white shadow">
          You control the screen · press <kbd className="rounded bg-white/20 px-1.5">Esc</kbd> to stop
        </div>
      )}
      {hasScreen && (
        <div className="absolute right-3 top-3 flex items-center gap-2">
          {canTake && fullscreen && (
            <p className="hidden rounded-md bg-black/70 px-2 py-1 text-xs sm:block text-zinc-300">
              Click to control the screen · paste types into it
            </p>
          )}
          <button
            type="button"
            aria-label={fullscreen ? 'Exit fullscreen' : 'Open fullscreen'}
            onClick={toggleFullscreen}
            className="flex size-9 cursor-pointer items-center justify-center rounded-md bg-black/50 text-zinc-300 hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

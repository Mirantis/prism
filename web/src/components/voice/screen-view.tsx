import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Maximize, Minimize, Monitor, LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { InputFrame } from '@/hooks/use-computer-screen';

interface ScreenViewProps {
  className?: string;
  /** Canvas for the live desktop stream. */
  screenRef: RefObject<HTMLCanvasElement | null>;
  hasScreen: boolean;
  /** Whether the desktop stream is still connecting. */
  connecting: boolean;
  /** Whether the runtime accepts pointer and keyboard input for this screen. */
  controllable: boolean;
  canTakeControl: boolean;
  onTakeControl: () => Promise<boolean>;
  onInput: (frame: InputFrame) => void;
  onRelease: () => void;
  /** Laid over the screen, e.g. the agent's tile. */
  children?: ReactNode;
}

const BUTTONS: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' };

/** The first click takes control without clicking anything on the desktop. */
export function ScreenView({
  className,
  screenRef,
  hasScreen,
  connecting,
  controllable,
  canTakeControl,
  onTakeControl,
  onInput,
  onRelease,
  children,
}: ScreenViewProps) {
  const releaseRef = useRef(onRelease);
  releaseRef.current = onRelease;
  const allowedRef = useRef(controllable);
  allowedRef.current = controllable;
  const releasing = useRef(false);
  const pending = useRef(false);
  const [acquiring, setAcquiring] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const release = useCallback(() => {
    if ((!allowedRef.current && !pending.current) || releasing.current) return;
    releasing.current = true;
    if (document.pointerLockElement) document.exitPointerLock();
    if (!pending.current) releaseRef.current();
  }, []);
  useEffect(() => {
    if (!controllable && !acquiring) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      release();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [controllable, acquiring, release]);
  useEffect(() => {
    if (!controllable && !pending.current && document.pointerLockElement === boxRef.current)
      document.exitPointerLock();
  }, [controllable]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [controlling, setControlling] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

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
    let locked = false;
    let lostFocus = false;
    let unlockTimer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      lostFocus = true;
    };
    const onLock = () => {
      const next = document.pointerLockElement === boxRef.current;
      const unlocked = locked && !next;
      locked = next;
      if (next) lostFocus = false;
      setControlling(next);
      // Native Escape can release pointer lock without delivering a keydown event.
      if (unlocked) {
        // Allow window focus to settle before treating native pointer unlock as Escape.
        unlockTimer = setTimeout(() => {
          if (!lostFocus && document.hasFocus() && document.visibilityState === 'visible')
            release();
        }, 100);
      }
    };
    const onFull = () => setFullscreen(document.fullscreenElement === boxRef.current);
    window.addEventListener('blur', onBlur);
    document.addEventListener('pointerlockchange', onLock);
    document.addEventListener('fullscreenchange', onFull);
    return () => {
      clearTimeout(unlockTimer);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('pointerlockchange', onLock);
      document.removeEventListener('fullscreenchange', onFull);
      if (document.pointerLockElement === boxRef.current) document.exitPointerLock();
      if (document.fullscreenElement === boxRef.current) void document.exitFullscreen();
    };
  }, [release]);

  useEffect(() => {
    if (!controlling || !controllable || acquiring) return;

    const send = (frame: InputFrame) => {
      if (!releasing.current) onInput(frame);
    };

    // Movement is gathered per animation frame; the runtime gathers again on its side.
    let dx = 0;
    let dy = 0;
    let flush: number | null = null;

    /**
     * Send the movement gathered so far, now.
     *
     * Anything that acts on where the pointer is goes out behind it. A click sent while a
     * frame's movement is still waiting would land where the pointer was a frame ago, and
     * the runtime cannot put the two back in order: it has not been told about the
     * movement yet.
     */
    const flushMove = () => {
      if (flush !== null) {
        cancelAnimationFrame(flush);
        flush = null;
      }
      if (dx === 0 && dy === 0) return;
      send({ type: 'pointer_move', dx, dy });
      dx = 0;
      dy = 0;
    };

    const onMove = (e: globalThis.MouseEvent) => {
      const { scale } = drawn();
      dx += e.movementX * scale;
      dy += e.movementY * scale;
      if (flush !== null) return;
      flush = requestAnimationFrame(flushMove);
    };
    const onButton = (down: boolean) => (e: globalThis.MouseEvent) => {
      e.preventDefault();
      const button = BUTTONS[e.button];
      if (!button) return;
      flushMove();
      send({ type: 'pointer_button', button, down });
    };
    const onDown = onButton(true);
    const onUp = onButton(false);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY === 0) return;
      flushMove();
      send({ type: 'wheel', dy: e.deltaY });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return;
      if (e.key.toLowerCase() === 'v' && (e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      send({
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
  }, [controlling, controllable, acquiring, onInput, drawn]);

  // Paste uses the viewer's clipboard while that viewer has desktop control.
  useEffect(() => {
    if (!controllable || !hasScreen || acquiring) return;
    const onPaste = (e: ClipboardEvent) => {
      if (releasing.current) return;
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
  }, [controllable, hasScreen, acquiring, onInput]);

  const takeControl = async (e: MouseEvent<HTMLDivElement>) => {
    const box = boxRef.current;
    if (!box || !canTakeControl || !hasScreen || controlling || pending.current) return;
    const rect = box.getBoundingClientRect();
    const { left, top, scale } = drawn();
    const pointer: InputFrame = {
      type: 'pointer',
      x: (e.clientX - rect.left - left) * scale,
      y: (e.clientY - rect.top - top) * scale,
    };
    releasing.current = false;
    pending.current = true;
    setAcquiring(true);
    setInputError(null);
    try {
      // Pointer lock needs the click's user activation; input waits for runtime ownership.
      await box.requestPointerLock();
      const granted = controllable || (await onTakeControl());
      pending.current = false;
      if (!granted) {
        releasing.current = true;
        if (document.pointerLockElement === box) document.exitPointerLock();
        return;
      }
      if (releasing.current) {
        releaseRef.current();
        return;
      }
      onInput(pointer);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      setAcquiring(false);
    }
  };

  const toggleFullscreen = (e: MouseEvent<HTMLButtonElement>) => {
    // Not a click on the screen: it must not take the pointer.
    e.stopPropagation();
    const box = boxRef.current;
    if (!box) return;
    if (document.fullscreenElement === box) void document.exitFullscreen();
    else void box.requestFullscreen();
  };

  const canTake = canTakeControl && hasScreen && !controlling && !acquiring;

  return (
    <div
      ref={boxRef}
      onClick={takeControl}
      className={cn(
        'relative aspect-video w-full overflow-hidden rounded-lg bg-zinc-950 select-none',
        canTake && 'cursor-pointer',
        className,
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
            {connecting ? (
              <LoaderCircle className="size-6 motion-safe:animate-spin" />
            ) : (
              <Monitor className="size-6" />
            )}
          </div>
          <p className="text-sm font-medium text-zinc-200">
            {connecting ? 'Preparing your computer' : 'Computer unavailable'}
          </p>
          <p className="max-w-xs text-xs leading-5 text-zinc-400">
            {connecting
              ? 'The agent’s screen will appear here when it is ready.'
              : 'Check the connection status above for details.'}
          </p>
        </div>
      )}
      {inputError && (
        <p
          role="alert"
          className="absolute bottom-3 left-3 right-3 rounded-md bg-black/80 p-2 text-sm text-white"
        >
          {inputError}
        </p>
      )}
      {acquiring && (
        <p className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-black/80 px-4 py-1.5 text-sm text-white">
          Taking control…
        </p>
      )}
      {fullscreen && controlling && controllable && !acquiring && (
        <div className="absolute left-3 top-3 rounded-lg border border-white/15 bg-zinc-900/90 px-3 py-2 text-xs font-medium text-white shadow">
          Your control · <kbd className="rounded bg-white/20 px-1.5">Esc</kbd> to return
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
      {/* Keep the border inside the screen so the page's scroll container preserves every edge. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] border border-zinc-700"
      />
    </div>
  );
}

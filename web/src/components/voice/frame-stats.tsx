import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { FrameEvent } from '@/hooks/use-voice-chat';

interface FrameStatsProps {
  /** The newest picture's arrival; null until the first one. */
  lastFrame: FrameEvent | null;
}

/** Frames inside this window count towards the rates. */
const WINDOW_MS = 1000;
/** How long the dot stays lit after a frame. */
const FLASH_MS = 150;
/** How often the readout re-reads the clock, so rates fall to zero while nothing arrives. */
const TICK_MS = 200;

/**
 * A readout of the pictures arriving for the screen: a dot that lights on each one, the
 * rate in frames and kilobytes a second, and the total. A still screen sends no frames,
 * so the dot stays dark and both rates read zero, which is what shows the suppression of
 * unchanged frames working.
 */
export function FrameStats({ lastFrame }: FrameStatsProps) {
  const recent = useRef<Array<{ at: number; bytes: number }>>([]);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (lastFrame) recent.current.push({ at: lastFrame.at, bytes: lastFrame.bytes });
  }, [lastFrame]);

  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const cutoff = now - WINDOW_MS;
  recent.current = recent.current.filter((f) => f.at >= cutoff);
  const fps = recent.current.length;
  const kbps = recent.current.reduce((n, f) => n + f.bytes, 0) / 1024;
  const lit = lastFrame !== null && now - lastFrame.at < FLASH_MS;

  return (
    <div
      aria-label="Screen frames received"
      className="flex items-center gap-2 rounded-md bg-black/60 px-2 py-1 font-mono text-xs text-zinc-300"
    >
      <span
        className={cn(
          'size-2 rounded-full transition-colors duration-100',
          lit ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]' : 'bg-zinc-600',
        )}
      />
      <span>{fps} fps</span>
      <span className="text-zinc-500">·</span>
      <span>{kbps.toFixed(0)} KB/s</span>
      <span className="text-zinc-500">·</span>
      <span>{(lastFrame?.count ?? 0).toLocaleString()} frames</span>
    </div>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { GripVertical } from 'lucide-react';

export function FloatingControls({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 12, y: 12 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const move = (x: number, y: number) => {
    const box = ref.current;
    const parent = box?.parentElement;
    if (!box || !parent) return;
    setPosition({
      x: Math.max(0, Math.min(x, parent.clientWidth - box.offsetWidth)),
      y: Math.max(0, Math.min(y, parent.clientHeight - box.offsetHeight)),
    });
  };
  useEffect(() => {
    const box = ref.current;
    if (!box?.parentElement) return;
    const observer = new ResizeObserver(() => {
      setPosition((current) => ({
        x: Math.max(0, Math.min(current.x, box.parentElement!.clientWidth - box.offsetWidth)),
        y: Math.max(0, Math.min(current.y, box.parentElement!.clientHeight - box.offsetHeight)),
      }));
    });
    observer.observe(box);
    observer.observe(box.parentElement);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      aria-label="Floating computer controls"
      className="absolute z-20 flex max-h-full max-w-[min(36rem,100%)] items-start gap-1 overflow-auto rounded-xl border bg-card/95 p-2 text-card-foreground shadow-lg backdrop-blur"
      style={{ left: position.x, top: position.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Move computer controls"
        title="Drag or use arrow keys to move controls"
        className="shrink-0 cursor-grab touch-none rounded p-1 focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        onPointerDown={(event) => {
          drag.current = {
            x: event.clientX - position.x,
            y: event.clientY - position.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current) move(event.clientX - drag.current.x, event.clientY - drag.current.y);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          const delta: Record<string, [number, number]> = {
            ArrowLeft: [-20, 0],
            ArrowRight: [20, 0],
            ArrowUp: [0, -20],
            ArrowDown: [0, 20],
          };
          const step = delta[event.key];
          if (!step) return;
          event.preventDefault();
          move(position.x + step[0], position.y + step[1]);
        }}
      >
        <GripVertical className="size-4" />
      </button>
      <div className="min-w-0 space-y-2">{children}</div>
    </div>
  );
}

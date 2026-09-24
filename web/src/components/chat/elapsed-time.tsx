import { useEffect, useState } from 'react';

/** How long something has run since `startedAt`, as `m:ss`: a recording, a call. */
export default function ElapsedTime({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);

  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <span className="font-mono text-xs tabular-nums text-muted-foreground" aria-hidden="true">
      {text}
    </span>
  );
}

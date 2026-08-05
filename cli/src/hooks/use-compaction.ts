import { useEffect, useRef, useState } from 'react';
import { tuiAdapterService, CompactionEvent } from '../tui-adapter.js';

/**
 * Compaction progress for the session's thread: true while one runs (shown as
 * the spinner-row label), plus a SYSTEM line when it ends. Same thread-filter
 * posture as the context-usage subscription in App — accept frames until the
 * active thread id is known. Auto-compaction failures stay silent (the user
 * never asked; server logs carry them).
 */
export function useCompaction(
  activeThreadId: string | undefined,
  appendSystemMessage: (text: string) => void,
): boolean {
  const [compacting, setCompacting] = useState(false);

  // The subscription is bound once; read the latest thread id through a ref so
  // it never closes over a stale value.
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;

  useEffect(() => {
    const onCompaction = (event: CompactionEvent) => {
      if (activeThreadIdRef.current !== undefined && event.threadId !== activeThreadIdRef.current) {
        return;
      }
      setCompacting(event.status === 'started');
      if (event.status === 'completed') {
        const n = event.messagesCompacted ?? 0;
        appendSystemMessage(`Conversation compacted — ${n} older message${n === 1 ? '' : 's'} summarized.`);
      } else if (event.status === 'failed' && event.trigger === 'manual') {
        appendSystemMessage(`Compaction failed: ${event.error ?? 'unknown error'}`);
      }
    };
    tuiAdapterService.events.on('compaction', onCompaction);
    return () => {
      tuiAdapterService.events.off('compaction', onCompaction);
    };
  }, [appendSystemMessage]);

  return compacting;
}

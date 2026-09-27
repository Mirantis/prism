import { useEffect, useState } from 'react';
import { tuiAdapterService, CompactionEvent } from '../tui-adapter.js';

/**
 * Compaction progress for the session's thread: true while one runs (shown as
 * the spinner-row label), plus a SYSTEM line when it ends. The adapter passes
 * on only this session's conversation. Auto-compaction failures stay silent
 * (the user never asked; server logs have them).
 */
export function useCompaction(appendSystemMessage: (text: string) => void): boolean {
  const [compacting, setCompacting] = useState(false);

  useEffect(() => {
    const onCompaction = (event: CompactionEvent) => {
      setCompacting(event.status === 'started');
      if (event.status === 'completed') {
        const n = event.messagesCompacted ?? 0;
        appendSystemMessage(`Conversation compacted — ${n} older message${n === 1 ? '' : 's'} summarized.`);
      } else if (event.status === 'skipped') {
        // A no-op, not an error: only worth saying when the user asked for it.
        if (event.trigger === 'manual') {
          appendSystemMessage(event.detail ?? 'Nothing to compact yet.');
        }
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

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ChatListener } from '@/lib/chat-socket/chat-connection';
import { useChatConnection } from '@/lib/chat-socket/chat-connection-context';

/** The events a component can hear. A reload after a lost replay belongs to the feed. */
export type ChatSocketHandlers = Omit<ChatListener, 'resync'>;

/**
 * The tab's chat socket: its state, its senders, and the events a component asks for.
 *
 * The handlers are read at the moment an event arrives, so a component can pass fresh
 * closures on every render without subscribing again.
 */
export function useChatSocket(handlers: ChatSocketHandlers = {}) {
  const connection = useChatConnection();
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(
    () =>
      connection.listen({
        message: (message) => handlersRef.current.message?.(message),
        turn: (event) => handlersRef.current.turn?.(event),
        thread: (event) => handlersRef.current.thread?.(event),
        context: (usage) => handlersRef.current.context?.(usage),
        compaction: (event) => handlersRef.current.compaction?.(event),
        computer: (status) => handlersRef.current.computer?.(status),
        update: (event) => handlersRef.current.update?.(event),
        voice: (event) => handlersRef.current.voice?.(event),
        voiceAudio: (frame) => handlersRef.current.voiceAudio?.(frame),
        dictation: (event) => handlersRef.current.dictation?.(event),
      }),
    [connection],
  );

  return { ...state, connection };
}

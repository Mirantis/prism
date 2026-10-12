import { useEffect } from 'react';
import { TURN_FAILED_TEXT, type TurnEventPayload } from '../chat-protocol.js';
import type { SignInRequest } from '../tui-adapter.js';
import { ProgramStatus, programStatusSequence } from '../program-status.js';

export interface SessionState {
  /** The conversation's last turn event, or null before the first one. */
  turn: TurnEventPayload | null;
  compacting: boolean;
  signIn: SignInRequest | null;
}

/** What the session waits for, or else what it is doing, or else how its last turn ended. */
function sessionStatus({ turn, compacting, signIn }: SessionState): ProgramStatus {
  if (signIn) return { state: 'blocked', kind: 'auth', msg: signIn.reason };
  if (turn?.state === 'running') return { state: 'working', msg: 'Thinking' };
  if (turn?.state === 'queued') {
    return { state: 'working', msg: 'Waiting for another conversation to finish' };
  }
  if (compacting) return { state: 'working', msg: 'Compacting the conversation' };
  if (turn?.outcome === 'completed') return { state: 'done', msg: 'Reply ready' };
  if (turn?.outcome === 'failed') return { state: 'error', msg: turn.error ?? TURN_FAILED_TEXT };
  // A cancelled turn is idle, as the specification asks.
  return { state: 'idle' };
}

/**
 * Reports the session's status to the terminal at each change, and clears it when the
 * session ends, because the terminal keeps a `done` or `error` record after the process
 * exits. Nothing is written when stdout is not a terminal.
 */
export function useProgramStatus(session: SessionState): void {
  const sequence = programStatusSequence(sessionStatus(session));

  useEffect(() => {
    if (process.stdout.isTTY) process.stdout.write(sequence);
  }, [sequence]);

  useEffect(
    () => () => {
      if (process.stdout.isTTY) process.stdout.write(programStatusSequence({ state: 'clear' }));
    },
    [],
  );
}

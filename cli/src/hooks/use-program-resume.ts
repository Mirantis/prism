import { useCallback, useEffect } from 'react';
import { programResumeSequence, type ResumeReporting } from '../program-resume.js';

/**
 * Reports to the terminal how to resume this session's conversation
 * (`--resume <id>`), when the conversation changes and when a child process gives
 * the terminal back. It writes only with `reporting` and when stdout is a terminal.
 *
 * Returns the function that clears the record, for a user exit only. A hang-up or a
 * termination unmounts the app too, and the terminal needs the record then.
 */
export function useProgramResume(
  reporting: ResumeReporting | undefined,
  threadId: string | undefined,
  suspended: boolean,
): () => void {
  useEffect(() => {
    if (!reporting || !threadId || suspended || !process.stdout.isTTY) return;
    const argv = [...reporting.command, '--resume', threadId];
    process.stdout.write(programResumeSequence({ argv, cwd: reporting.cwd }, reporting.token));
  }, [reporting, threadId, suspended]);

  return useCallback(() => {
    if (!reporting || !process.stdout.isTTY) return;
    process.stdout.write(programResumeSequence({ clear: true }, reporting.token));
  }, [reporting]);
}

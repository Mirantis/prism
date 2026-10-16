import { useComputers } from '@/hooks/use-computers';
import { ComputerQueueNotice } from './computer-queue-notice';

/** The notice for the computer a conversation waits for, when it waits for one. */
export function ComputerWaiting({ threadId }: { threadId?: string }) {
  const { data: computers } = useComputers();
  if (!threadId || !computers) return null;
  return (
    <>
      {computers.map((computer) => (
        <ComputerQueueNotice key={computer.id} computerId={computer.id} threadId={threadId} />
      ))}
    </>
  );
}

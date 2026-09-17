import { CircleCheck, CircleX, Monitor } from 'lucide-react';
import { useComputerStatus } from '@/hooks/use-computer-status';
import type { ComputerHelp } from '@/types';

export function ChatComputerHelp({ help }: { help: ComputerHelp }) {
  const { data } = useComputerStatus();
  const current = data?.help?.find((item) => item.id === help.id) ?? help;
  const dismissed = current.status === 'dismissed';
  const completed = current.status === 'continued';
  const Icon = dismissed ? CircleX : completed ? CircleCheck : Monitor;
  const label = dismissed
    ? 'Computer help dismissed'
    : completed
      ? 'Computer help completed'
      : 'Computer help requested';

  return (
    <div
      aria-label="Computer help status"
      className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="font-medium text-foreground">{label}</p>
        <p className="mt-0.5 break-words text-xs text-muted-foreground">{help.reason}</p>
      </div>
    </div>
  );
}

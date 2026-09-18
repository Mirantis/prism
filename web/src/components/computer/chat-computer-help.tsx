import { useState } from 'react';
import { CircleCheck, CircleX, Monitor } from 'lucide-react';
import { useComputerStatus } from '@/hooks/use-computer-status';
import { SignInForm } from '@/components/computer/sign-in-form';
import type { ComputerHelp } from '@/types';

export function ChatComputerHelp({
  help,
  onOpen,
}: {
  help: ComputerHelp;
  onOpen: (id: string) => void;
}) {
  const { data } = useComputerStatus();
  const current = data?.help?.find((item) => item.id === help.id) ?? help;
  const [expanded, setExpanded] = useState(true);
  const dismissed = current.status === 'dismissed';
  const completed = current.status === 'continued';
  const Icon = dismissed ? CircleX : completed ? CircleCheck : Monitor;
  const label = dismissed
    ? 'Computer help dismissed'
    : completed
      ? 'Computer help completed'
      : current.credentials
        ? 'Prism needs a sign-in'
        : 'Computer help requested';
  const content = (
    <>
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="font-medium text-foreground">{label}</p>
        <p className="mt-0.5 break-words text-xs text-muted-foreground">{help.reason}</p>
      </div>
    </>
  );

  // A sign-in is answered here rather than on the desktop, so the box for it opens with
  // the message and the live screen is never slid over the chat for one.
  if (!dismissed && !completed && current.credentials) {
    if (!expanded) {
      return (
        <button
          type="button"
          aria-label="Open sign-in"
          onClick={() => setExpanded(true)}
          className="flex w-full items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {content}
        </button>
      );
    }
    return (
      <section
        aria-label="Computer sign-in"
        className="space-y-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
      >
        <div className="flex items-start gap-2">{content}</div>
        <SignInForm help={current} onCancel={() => setExpanded(false)} />
      </section>
    );
  }

  if (!dismissed && !completed) {
    return (
      <button
        type="button"
        onClick={() => onOpen(help.id)}
        className="flex w-full items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {content}
      </button>
    );
  }

  return (
    <div
      role="status"
      aria-label="Computer help status"
      className="flex items-start gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"
    >
      {content}
    </div>
  );
}

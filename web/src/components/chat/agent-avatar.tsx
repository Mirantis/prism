import { cn } from '@/lib/utils';

/** The agent's mark beside what it says in a conversation. */
export default function AgentAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('brand-tile flex size-7 shrink-0 items-center justify-center rounded-lg', className)}
    >
      <img src="/prism-logo.svg" alt="" width={16} height={16} />
    </span>
  );
}

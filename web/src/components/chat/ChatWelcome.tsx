import { useAgent } from '@/lib/agent-context';

export default function ChatWelcome() {
  const agent = useAgent();
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-12 text-center">
      <div className="welcome-mark mb-7 flex size-20 items-center justify-center rounded-3xl border border-border bg-card">
        <img src="/prism-logo.svg" alt="" className="size-11" />
      </div>
      <p className="eyebrow mb-3">A little direction goes a long way</p>
      <h2 className="max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
        What shall we work on?
      </h2>
      <p className="mt-4 max-w-md text-sm leading-7 text-muted-foreground">
        Share an idea, ask a question, or give {agent.name} a task. Start with whatever is on your
        mind.
      </p>
    </div>
  );
}

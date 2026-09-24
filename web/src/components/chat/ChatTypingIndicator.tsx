import AgentAvatar from './agent-avatar';

/** The agent at work: three moving dots beside its mark. */
export default function ChatTypingIndicator() {
  return (
    <div className="flex items-center gap-3 animate-in fade-in-0 duration-300" data-testid="chat-typing-indicator">
      <AgentAvatar />
      <div className="flex h-8 items-center gap-1 rounded-full bg-muted/30 px-3.5 ring-1 ring-border ring-inset">
        <span className="sr-only">The agent is working</span>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            aria-hidden="true"
            className="size-1.5 rounded-full bg-foreground animate-typing-dot"
            style={{ animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  );
}

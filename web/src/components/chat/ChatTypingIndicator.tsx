import AgentAvatar from './agent-avatar';

export default function ChatTypingIndicator() {
  return (
    <div className="flex items-center gap-3" data-testid="chat-typing-indicator">
      <AgentAvatar />
      <div className="flex h-8 items-center gap-1 rounded-full bg-muted/30 px-3.5 ring-1 ring-border ring-inset">
        <span className="sr-only">The agent is working</span>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-1.5 rounded-full bg-foreground"
            style={{ animation: 'typing-dot 1.2s ease-in-out infinite', animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </div>
    </div>
  );
}

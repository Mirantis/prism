import { createFileRoute } from '@tanstack/react-router';
import AgentChat from '@/components/chat/AgentChat';

export const Route = createFileRoute('/chat')({
  component: ChatPage,
});

function ChatPage() {
  // Escape main's overflow-auto so the chat input pins at the bottom and only
  // the message list scrolls. Anchored to main (which is `relative`).
  return (
    <div className="absolute inset-0 flex flex-col">
      <AgentChat />
    </div>
  );
}

import { createFileRoute, Outlet, useParams } from '@tanstack/react-router';
import AgentChat from '@/components/chat/AgentChat';

export const Route = createFileRoute('/chat')({
  component: ChatPage,
});

function ChatPage() {
  // Optional thread id from the /chat/$threadId child route (undefined at bare
  // /chat → latest thread). Read loosely so this parent stays mounted across
  // thread navigation, keeping AgentChat's WebSocket connected — only the prop
  // changes. The child route renders nothing; the screen lives here.
  const { threadId } = useParams({ strict: false });
  // Escape main's overflow-auto so the chat input pins at the bottom and only
  // the message list scrolls. Anchored to main (which is `relative`).
  return (
    <div className="absolute inset-0 flex flex-col">
      <AgentChat threadId={threadId} />
      <Outlet />
    </div>
  );
}

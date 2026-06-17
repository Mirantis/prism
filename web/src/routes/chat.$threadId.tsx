import { createFileRoute } from '@tanstack/react-router';

// The /chat/<threadId> screen is rendered by the parent `chat` route, which
// stays mounted across thread navigation so the chat WebSocket isn't churned.
// This route only declares the path + threadId param so the URL is matchable
// and `<Link to="/chat/$threadId" params={{ threadId }}>` typechecks.
export const Route = createFileRoute('/chat/$threadId')({
  component: () => null,
});

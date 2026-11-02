import { createFileRoute, redirect } from '@tanstack/react-router';
import { codingAgentSignInSearch } from '@/lib/coding-agents';

/** The link the agent sends to sign a coding agent in: the Profile page, with its sign-in open. */
export const Route = createFileRoute('/coding-agents')({
  validateSearch: codingAgentSignInSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/profile', search, replace: true });
  },
});

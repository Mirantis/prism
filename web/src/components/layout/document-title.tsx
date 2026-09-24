import { useEffect } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useAgent } from '@/lib/agent-context';
import { navItemFor } from '@/lib/nav';
import { threadDisplayName } from '@/lib/thread-name';
import { useCurrentConversation } from '@/hooks/use-current-conversation';

/** The browser tab's title: the conversation or page on screen, then the agent's name. */
export function DocumentTitle() {
  const agent = useAgent();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const conversation = useCurrentConversation();
  const page = navItemFor(pathname);

  const subject = conversation ? threadDisplayName(conversation) : page && page.to !== '/' ? page.label : null;
  const title = subject ? `${subject} · ${agent.name}` : agent.name;

  useEffect(() => {
    document.title = title;
  }, [title]);
  return null;
}

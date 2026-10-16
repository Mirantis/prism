// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentSummary } from '@/types';

/** The router and the sidebar chrome are not what this asserts; the nav list is. */
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useRouterState: () => '/',
}));
vi.mock('./recents-nav', () => ({ RecentsNav: () => null }));
vi.mock('./agent-presence', () => ({ AgentPresence: () => null }));
vi.mock('./new-chat-button', () => ({ NewChatButton: () => null }));
vi.mock('./search-button', () => ({ SearchButton: () => null }));
vi.mock('@/components/ui/sidebar', () => {
  const passthrough =
    (tag: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      tag === 'button' ? <button type="button">{children}</button> : <div>{children}</div>;
  return {
    Sidebar: passthrough('div'),
    SidebarContent: passthrough('div'),
    SidebarGroup: passthrough('div'),
    SidebarGroupLabel: passthrough('div'),
    SidebarHeader: passthrough('div'),
    SidebarMenu: passthrough('div'),
    SidebarMenuButton: passthrough('button'),
    SidebarMenuItem: passthrough('div'),
    SidebarRail: passthrough('div'),
    useSidebar: () => ({ setOpenMobile: () => {} }),
  };
});

let agent: AgentSummary = { agentId: 'a1', userId: 'u1', name: 'Prism' };
vi.mock('@/lib/agent-context', () => ({ useAgent: () => agent }));

const { AppSidebar } = await import('./app-sidebar');

describe('the Computer page in the sidebar', () => {
  it('is offered on a runtime without a desktop of its own, where a remote computer can connect', () => {
    agent = { agentId: 'a1', userId: 'u1', name: 'Prism', hasComputer: false };
    render(<AppSidebar />);
    expect(screen.getByText('Computer')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });
});

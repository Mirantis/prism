// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentSummary } from '@/types';

/** The router and the sidebar chrome are not what this asserts; the nav list is. */
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useRouterState: () => '/',
}));
vi.mock('./recents-nav', () => ({ RecentsNav: () => null }));
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
    SidebarFooter: passthrough('div'),
    useSidebar: () => ({ setOpenMobile: vi.fn() }),
    SidebarMenu: passthrough('div'),
    SidebarMenuButton: passthrough('button'),
    SidebarMenuItem: passthrough('div'),
  };
});

let agent: AgentSummary = { agentId: 'a1', userId: 'u1', name: 'Prism' };
vi.mock('@/lib/agent-context', () => ({ useAgent: () => agent }));

const { AppSidebar } = await import('./app-sidebar');

afterEach(cleanup);

describe('the Computer page in the sidebar', () => {
  it('is offered where the runtime can give the agent a computer', () => {
    agent = { agentId: 'a1', userId: 'u1', name: 'Prism', hasComputer: true };
    render(<AppSidebar />);
    expect(screen.getByText('Computer')).toBeInTheDocument();
  });

  it('is left out where it has no desktop for one', () => {
    agent = { agentId: 'a1', userId: 'u1', name: 'Prism', hasComputer: false };
    render(<AppSidebar />);
    expect(screen.queryByText('Computer')).not.toBeInTheDocument();
    // The rest of the navigation is untouched.
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });

  it('is left out on a runtime too old to answer the question', () => {
    agent = { agentId: 'a1', userId: 'u1', name: 'Prism' };
    render(<AppSidebar />);
    expect(screen.queryByText('Computer')).not.toBeInTheDocument();
  });
});

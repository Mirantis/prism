import { createRootRoute, Outlet } from '@tanstack/react-router';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { AppBreadcrumb } from '@/components/layout/app-breadcrumb';
import { UpdateBanner } from '@/components/layout/update-banner';
import { HeaderActionsSlot } from '@/components/layout/header-actions-slot';
import { AgentProvider } from '@/lib/agent-context';
import { HeaderActionsProvider } from '@/lib/header-actions-context';
import { CommandMenuProvider } from '@/lib/command-menu-context';
import { CommandMenu } from '@/components/layout/command-menu';
import { DocumentTitle } from '@/components/layout/document-title';

export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * The app shell fills the viewport and the content pane scrolls inside it, so the sidebar,
 * the header and the pane's frame stay put on every page and at every width.
 */
function RootLayout() {
  return (
    <AgentProvider>
      <TooltipProvider>
        <SidebarProvider className="h-dvh overflow-hidden">
          <CommandMenuProvider>
            <a href="#main-content" className="skip-link">
              Skip to content
            </a>
            <AppSidebar />
            <CommandMenu />
            <DocumentTitle />
            <HeaderActionsProvider>
              <SidebarInset className="app-canvas flex min-h-0 flex-col overflow-hidden md:ring-1 md:ring-foreground/5">
                <header className="flex h-14 shrink-0 items-center gap-2">
                  <div className="flex min-w-0 items-center gap-2 px-4 md:px-6">
                    <SidebarTrigger className="-ml-1.5 text-muted-foreground hover:text-strong" />
                    <Separator orientation="vertical" className="mr-1 h-4" />
                    <AppBreadcrumb />
                  </div>
                  <HeaderActionsSlot />
                </header>
                <UpdateBanner />
                {/* A div: the inset is already the page's one <main>. */}
                <div
                  id="main-content"
                  tabIndex={-1}
                  className="relative min-h-0 min-w-0 flex-1 overflow-auto px-4 pt-2 pb-6 outline-none md:px-8"
                >
                  <Outlet />
                </div>
              </SidebarInset>
            </HeaderActionsProvider>
          </CommandMenuProvider>
        </SidebarProvider>
      </TooltipProvider>
    </AgentProvider>
  );
}

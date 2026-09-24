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

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  return (
    <AgentProvider>
      <TooltipProvider>
        <SidebarProvider className="app-shell">
          <a href="#main-content" className="skip-link">
            Skip to content
          </a>
          <AppSidebar />
          <HeaderActionsProvider>
            <SidebarInset className="workspace-panel flex min-w-0 flex-col">
              <header className="workspace-header flex h-16 shrink-0 items-center gap-2 border-b border-border/60">
                <div className="flex min-w-0 items-center gap-2 px-4">
                  <SidebarTrigger className="-ml-1" />
                  <Separator orientation="vertical" className="mr-2 h-4" />
                  <AppBreadcrumb />
                </div>
                <HeaderActionsSlot />
              </header>
              <UpdateBanner />
              <div
                id="main-content"
                tabIndex={-1}
                className="workspace-main relative min-h-0 min-w-0 flex-1 overflow-auto p-5 sm:p-8 lg:p-10"
              >
                <Outlet />
              </div>
            </SidebarInset>
          </HeaderActionsProvider>
        </SidebarProvider>
      </TooltipProvider>
    </AgentProvider>
  );
}

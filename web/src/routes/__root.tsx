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
        <SidebarProvider>
          <AppSidebar />
          <HeaderActionsProvider>
            <SidebarInset className="flex flex-col">
              <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
                <div className="flex min-w-0 items-center gap-2 px-4">
                  <SidebarTrigger className="-ml-1" />
                  <Separator orientation="vertical" className="mr-2 h-4" />
                  <AppBreadcrumb />
                </div>
                <HeaderActionsSlot />
              </header>
              <UpdateBanner />
              <main className="relative flex-1 overflow-auto p-4 pt-0 min-w-0">
                <Outlet />
              </main>
            </SidebarInset>
          </HeaderActionsProvider>
        </SidebarProvider>
      </TooltipProvider>
    </AgentProvider>
  );
}

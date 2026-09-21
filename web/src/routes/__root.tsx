import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { AppBreadcrumb } from '@/components/layout/app-breadcrumb';
import { UpdateBanner } from '@/components/layout/update-banner';
import { AgentProvider } from '@/lib/agent-context';
import { ComputerWindowProvider } from '@/components/computer/computer-window-provider';

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const popup = useRouterState({
    select: (state) => state.location.pathname === '/computer-window',
  });
  return (
    <AgentProvider>
      <ComputerWindowProvider>
        <TooltipProvider>
          {popup ? (
            <main className="h-dvh w-screen overflow-hidden">
              <Outlet />
            </main>
          ) : (
            <SidebarProvider>
              <AppSidebar />
              <SidebarInset className="flex flex-col">
                <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12">
                  <div className="flex items-center gap-2 px-4">
                    <SidebarTrigger className="-ml-1" />
                    <Separator orientation="vertical" className="mr-2 h-4" />
                    <AppBreadcrumb />
                  </div>
                </header>
                <UpdateBanner />
                <main className="relative flex-1 overflow-auto p-4 pt-0 min-w-0">
                  <Outlet />
                </main>
              </SidebarInset>
            </SidebarProvider>
          )}
        </TooltipProvider>
      </ComputerWindowProvider>
    </AgentProvider>
  );
}

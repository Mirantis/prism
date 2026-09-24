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
            <SidebarInset className="app-canvas flex flex-col md:ring-1 md:ring-foreground/5">
              <header className="flex h-14 shrink-0 items-center gap-2">
                <div className="flex min-w-0 items-center gap-2 px-4 md:px-6">
                  <SidebarTrigger className="-ml-1.5 text-muted-foreground hover:text-strong" />
                  <Separator orientation="vertical" className="mr-1 h-4" />
                  <AppBreadcrumb />
                </div>
                <HeaderActionsSlot />
              </header>
              <UpdateBanner />
              <main className="relative min-w-0 flex-1 overflow-auto px-4 pt-2 pb-6 md:px-8">
                <Outlet />
              </main>
            </SidebarInset>
          </HeaderActionsProvider>
        </SidebarProvider>
      </TooltipProvider>
    </AgentProvider>
  );
}

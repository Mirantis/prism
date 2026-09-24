import { SquarePen } from 'lucide-react';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { useCreateThread } from '@/hooks/use-create-thread';

/** The sidebar's "New chat" button: a fresh conversation from any page. */
export function NewChatButton() {
  const { create, isPending, error } = useCreateThread();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          data-testid="sidebar-new-chat"
          tooltip="New chat"
          disabled={isPending}
          onClick={create}
          className="h-9 bg-primary/10 font-medium text-strong ring-1 ring-primary/25 ring-inset hover:bg-primary/15 hover:text-strong [&>svg]:text-primary"
        >
          <SquarePen />
          <span>New chat</span>
        </SidebarMenuButton>
        {error && (
          <span role="alert" className="block px-2 pt-1 text-xs text-destructive group-data-[collapsible=icon]:hidden">
            {error}
          </span>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

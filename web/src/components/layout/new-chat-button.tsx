import { SquarePen } from 'lucide-react';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { useCreateThread } from '@/hooks/use-create-thread';
import { cn } from '@/lib/utils';

/**
 * The sidebar's "New chat" button: a fresh conversation from any page. A failure is said in
 * words under the button, in the button's tooltip when the sidebar is icons only, and to a
 * screen reader either way.
 */
export function NewChatButton() {
  const { create, isPending, error } = useCreateThread();
  const failure = error ? `New chat failed: ${error}` : null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          data-testid="sidebar-new-chat"
          tooltip={failure ?? 'New chat'}
          disabled={isPending}
          onClick={create}
          className={cn(
            'h-9 bg-primary/10 font-medium text-strong ring-1 ring-primary/25 ring-inset hover:bg-primary/15 hover:text-strong [&>svg]:text-primary',
            failure && 'ring-destructive/50 [&>svg]:text-destructive',
          )}
        >
          <SquarePen />
          <span>New chat</span>
        </SidebarMenuButton>
        {failure && (
          <>
            <span role="alert" className="sr-only">
              {failure}
            </span>
            <span aria-hidden="true" className="block px-2 pt-1 text-xs text-destructive group-data-[collapsible=icon]:hidden">
              {error}
            </span>
          </>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

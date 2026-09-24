import { Search } from 'lucide-react';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { useCommandMenu } from '@/lib/command-menu-context';
import { MOD_KEY } from '@/lib/platform';

/** Opens the command palette, and shows the shortcut that does the same. */
export function SearchButton() {
  const { setOpen } = useCommandMenu();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={`Search (${MOD_KEY}K)`}
          onClick={() => setOpen(true)}
          data-testid="sidebar-search"
          className="text-muted-foreground"
        >
          <Search />
          <span>Search</span>
          <kbd className="ml-auto rounded border border-border px-1.5 font-sans text-[10px] text-muted-foreground group-data-[collapsible=icon]:hidden">
            {MOD_KEY} K
          </kbd>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

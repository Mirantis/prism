import type { ReactNode } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from '@tanstack/react-router';
import { MessageSquare, PanelLeft, Search, SquarePen } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useSidebar } from '@/components/ui/sidebar';
import { useCommandMenu } from '@/lib/command-menu-context';
import { NAV_GROUPS } from '@/lib/nav';
import { MOD_KEY } from '@/lib/platform';
import { threadDisplayName } from '@/lib/thread-name';
import { formatRelativeTime } from '@/lib/format';
import { useCreateThread } from '@/hooks/use-create-thread';
import { useRecentThreads } from '@/hooks/use-recent-threads';

const GROUP =
  'px-1.5 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground';

/**
 * Every typed word has to appear in the item's words. An item's value is its id, and ids never
 * match: fuzzy scoring over a UUID lights up conversations for any short query.
 */
function matches(_value: string, search: string, keywords?: string[]): number {
  const haystack = (keywords ?? []).join(' ').toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
    ? 1
    : 0;
}

function Item({
  value,
  keywords,
  disabled,
  onSelect,
  children,
}: {
  value: string;
  keywords?: string[];
  disabled?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      disabled={disabled}
      onSelect={onSelect}
      data-testid="command-item"
      className="flex h-9 cursor-pointer items-center gap-3 rounded-lg px-2 text-sm text-foreground data-[selected=true]:bg-accent data-[selected=true]:text-strong [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
    >
      {children}
    </Command.Item>
  );
}

/** Jump to any page or conversation, or run an action, by typing. */
export function CommandMenu() {
  const navigate = useNavigate();
  const { open, setOpen } = useCommandMenu();
  const { toggleSidebar } = useSidebar();
  const createThread = useCreateThread();
  const { data: threads } = useRecentThreads({ enabled: open });

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };
  const pages = NAV_GROUPS.flatMap((g) => g.items);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        data-testid="command-menu"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <Command loop filter={matches} className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Command.Input
              autoFocus
              placeholder="Search pages, conversations and actions…"
              aria-label="Search"
              className="h-12 w-full bg-transparent text-[15px] text-strong outline-none placeholder:text-muted-foreground"
            />
          </div>
          <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto py-1">
            <Command.Empty className="py-10 text-center text-sm text-muted-foreground">
              Nothing matches.
            </Command.Empty>
            <Command.Group heading="Actions" className={GROUP}>
              {/* Stays open until the conversation exists, so a failure is said here rather
                  than in a component that is no longer on screen. */}
              <Item
                value="action-new-chat"
                keywords={['New chat', 'conversation', 'start']}
                disabled={createThread.isPending}
                onSelect={async () => {
                  if (await createThread.create()) setOpen(false);
                }}
              >
                <SquarePen />
                New chat
              </Item>
              <Item value="action-toggle-sidebar" keywords={['Toggle sidebar', 'collapse', 'expand']} onSelect={() => run(toggleSidebar)}>
                <PanelLeft />
                Toggle sidebar
                <kbd className="ml-auto font-sans text-[11px] text-muted-foreground [@media(hover:none)]:hidden">
                  {MOD_KEY} B
                </kbd>
              </Item>
            </Command.Group>
            <Command.Group heading="Pages" className={GROUP}>
              {pages.map(({ to, label, icon: Icon }) => (
                <Item key={to} value={`page-${to}`} keywords={[label, 'go to page']} onSelect={() => run(() => navigate({ to }))}>
                  <Icon />
                  {label}
                </Item>
              ))}
            </Command.Group>
            {threads && threads.length > 0 && (
              <Command.Group heading="Conversations" className={GROUP}>
                {threads.map((thread) => {
                  const name = threadDisplayName(thread);
                  return (
                    <Item
                      key={thread.id}
                      value={thread.id}
                      keywords={[name, 'conversation']}
                      onSelect={() => run(() => navigate({ to: '/chat/$threadId', params: { threadId: thread.id } }))}
                    >
                      <MessageSquare />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatRelativeTime(thread.updatedAt)}
                      </span>
                    </Item>
                  );
                })}
              </Command.Group>
            )}
          </Command.List>
          {createThread.error && (
            <p role="alert" data-testid="command-menu-error" className="border-t border-border px-4 py-2 text-xs text-destructive">
              {createThread.error}
            </p>
          )}
          {/* Keyboard hints, hidden on a touch screen. */}
          <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-muted-foreground [@media(hover:none)]:hidden">
            <span>↑↓ to move</span>
            <span>↵ to open</span>
            <span>Esc to close</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

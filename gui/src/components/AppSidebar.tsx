import { MessageSquare, type LucideIcon } from 'lucide-react';

/** Left-nav items. Mirrors the web app's AppSidebar — just Chat for now. */
const NAV_ITEMS = [{ id: 'chat', label: 'Chat', icon: MessageSquare }] as const;

export type ViewId = (typeof NAV_ITEMS)[number]['id'];

interface Props {
  active: ViewId;
  onSelect: (id: ViewId) => void;
}

export function AppSidebar({ active, onSelect }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img src="/prism-logo.svg" alt="Prism" width={28} height={28} />
        <div className="sidebar-brand">
          <span className="sidebar-brand-name">Prism</span>
          <span className="sidebar-brand-sub">Agent runtime</span>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map(({ id, label, icon }) => {
          const Icon: LucideIcon = icon;
          return (
            <button
              key={id}
              type="button"
              className={`sidebar-link${active === id ? ' active' : ''}`}
              onClick={() => onSelect(id)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

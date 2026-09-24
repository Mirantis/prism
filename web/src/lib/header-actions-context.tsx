import { createContext, useContext, useState, type ReactNode } from 'react';

/**
 * Where a page puts controls in the header's top-right corner.
 *
 * The header belongs to the root layout and the controls to the page that owns their
 * state, so the header holds a slot and the page portals into it. A page that renders
 * nothing there leaves the corner empty.
 */
interface HeaderActionsValue {
  target: HTMLElement | null;
  setTarget: (element: HTMLElement | null) => void;
}

const HeaderActionsContext = createContext<HeaderActionsValue | null>(null);

export function HeaderActionsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  return (
    <HeaderActionsContext.Provider value={{ target, setTarget }}>
      {children}
    </HeaderActionsContext.Provider>
  );
}

/** The slot, or null outside a provider — a page rendered on its own shows no actions. */
export function useHeaderActions(): HeaderActionsValue | null {
  return useContext(HeaderActionsContext);
}

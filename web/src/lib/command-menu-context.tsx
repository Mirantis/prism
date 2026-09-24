import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isMac } from './platform';

interface CommandMenuState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CommandMenuContext = createContext<CommandMenuState | null>(null);

/**
 * Whether the command palette is open. ⌘K on a Mac and Ctrl+K elsewhere opens and closes it
 * from anywhere. Ctrl+K on a Mac is left alone, since text fields there use it to delete to the
 * end of the line.
 */
export function CommandMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // A page that took the key first keeps it: the Computer page forwards every key to
      // the remote desktop while it holds the pointer.
      if (e.defaultPrevented) return;
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (e.key.toLowerCase() === 'k' && mod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <CommandMenuContext.Provider value={value}>{children}</CommandMenuContext.Provider>;
}

export function useCommandMenu(): CommandMenuState {
  const state = useContext(CommandMenuContext);
  if (!state) throw new Error('useCommandMenu needs a CommandMenuProvider');
  return state;
}

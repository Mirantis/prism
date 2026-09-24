import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useHeaderActions } from '@/lib/header-actions-context';

/** Render `children` in the header's top-right corner, while this page is on screen. */
export function HeaderActions({ children }: { children: ReactNode }) {
  const target = useHeaderActions()?.target;
  return target ? createPortal(children, target) : null;
}

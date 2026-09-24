import { useHeaderActions } from '@/lib/header-actions-context';

/** The header's top-right corner, which the page on screen fills with `HeaderActions`. */
export function HeaderActionsSlot() {
  const slot = useHeaderActions();
  return <div ref={slot?.setTarget} className="ml-auto flex items-center gap-2 px-4" />;
}

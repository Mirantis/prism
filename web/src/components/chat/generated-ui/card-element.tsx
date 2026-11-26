import type { ReactNode } from 'react';

/** A titled group of elements. */
export function CardElement({ title, children }: { title: string | undefined; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {title && <h3 className="text-[0.9375rem] font-semibold break-words text-strong">{title}</h3>}
      {children}
    </div>
  );
}

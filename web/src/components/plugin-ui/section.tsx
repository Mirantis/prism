import type { ReactNode } from 'react';

export interface SectionProps {
  title?: string;
  description?: string;
  children?: ReactNode;
}

/** A titled block inside a plugin page. */
export function Section({ title, description, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-3">
      {(title || description) && (
        <div className="flex flex-col gap-1">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

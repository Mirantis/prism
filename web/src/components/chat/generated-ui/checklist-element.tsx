import { Circle, CircleCheck } from 'lucide-react';

export function ChecklistElement({ items }: { items: { text: string; done: boolean }[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2">
          {item.done ? (
            <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
          ) : (
            <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 break-words text-foreground">
            {item.text}
            <span className="sr-only">{item.done ? ', done' : ', not done'}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

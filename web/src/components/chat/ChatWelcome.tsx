import { Bot } from 'lucide-react';

export default function ChatWelcome() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-xl border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
          <Bot className="size-6 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">
          Hey there! I'm your AI companion.
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Just say hello and we'll get started — it only takes a minute!
        </p>
      </div>
    </div>
  );
}

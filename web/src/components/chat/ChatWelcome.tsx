import { Brain, Clock, HeartPulse, Sparkles } from 'lucide-react';
import { IconTile } from '@/components/shared/icon-tile';
import type { Tone } from '@/lib/tones';

const SUGGESTIONS: { icon: typeof Sparkles; tone: Tone; title: string; prompt: string }[] = [
  {
    icon: Sparkles,
    tone: 'primary',
    title: 'What can you do?',
    prompt: 'What can you do? Give me a short tour of your abilities.',
  },
  {
    icon: Brain,
    tone: 'teal',
    title: 'What do you remember about me?',
    prompt: 'Summarize what you remember about me and my work.',
  },
  {
    icon: Clock,
    tone: 'warning',
    title: 'Send me a daily brief',
    prompt: 'Every weekday at 9:00, send me a short summary of anything that needs my attention.',
  },
  {
    icon: HeartPulse,
    tone: 'success',
    title: 'Keep an eye on something',
    prompt: 'Help me set up a heartbeat check for something you should keep an eye on.',
  },
];

/**
 * An empty conversation: a greeting and a few first messages to send with one press.
 * `onSuggestion` is absent while nothing can be sent.
 */
export default function ChatWelcome({
  agentName,
  onSuggestion,
}: {
  agentName: string;
  onSuggestion?: (prompt: string) => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl space-y-8 text-center">
        <div className="space-y-4">
          <div className="brand-tile mx-auto flex size-14 items-center justify-center rounded-2xl">
            <img src="/prism-logo.svg" alt="" width={30} height={30} />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight text-strong">How can I help today?</h2>
            <p className="text-sm text-foreground/75">
              I'm {agentName}. Ask me anything, or start with one of these.
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2" data-testid="chat-suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              type="button"
              disabled={!onSuggestion}
              onClick={() => onSuggestion?.(s.prompt)}
              data-testid="chat-suggestion"
              className="group/suggestion flex items-start gap-3 rounded-xl text-left bg-card p-3.5 ring-1 ring-foreground/10 transition-all outline-none hover:-translate-y-0.5 hover:ring-foreground/20 hover:shadow-lg hover:shadow-black/20 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            >
              <IconTile icon={s.icon} tone={s.tone} />
              <span className="min-w-0 space-y-0.5">
                <span className="block text-sm font-medium text-strong">{s.title}</span>
                <span className="line-clamp-2 block text-xs text-muted-foreground">{s.prompt}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

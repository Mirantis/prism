import { useRef, useEffect, type FormEvent, type KeyboardEvent } from 'react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { ArrowUp, Loader2 } from 'lucide-react';
import type { ConnectionStatus } from '@/hooks/use-websocket';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (e: FormEvent) => void;
  isPending: boolean;
  connectionStatus: ConnectionStatus;
}

const statusColors: Record<ConnectionStatus, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-yellow-500 animate-pulse',
  disconnected: 'bg-muted-foreground',
  error: 'bg-destructive',
};

export default function ChatInput({ value, onChange, onSend, isPending, connectionStatus }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isPending) onSend(e as unknown as FormEvent);
    }
  };

  const isDisabled = !value.trim() || isPending;

  return (
    <div className="border-t bg-background">
      {connectionStatus !== 'connected' && (
        <div className="flex items-center justify-center gap-2 bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground">
          <span className={`inline-block size-1.5 rounded-full ${statusColors[connectionStatus]}`} />
          {connectionStatus === 'connecting' ? 'Connecting…' : 'Disconnected'}
        </div>
      )}
      <div className="px-4 py-3">
        <form onSubmit={onSend}>
          <InputGroup className="h-auto">
            <InputGroupAddon align="inline-start">
              <span
                className={`inline-block size-2 rounded-full ${statusColors[connectionStatus]}`}
                title={connectionStatus}
              />
            </InputGroupAddon>
            <InputGroupTextarea
              ref={textareaRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Message your agent..."
              rows={1}
              className="max-h-40 min-h-[36px]"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="submit"
                size="icon-xs"
                variant={isDisabled ? 'ghost' : 'default'}
                disabled={isDisabled}
                className="rounded-full"
              >
                {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </div>
  );
}

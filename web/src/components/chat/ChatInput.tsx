import {
  useRef,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import type { ConnectionStatus } from '@/hooks/use-websocket';
import type { ContextUsage } from '@/types';
import { PendingAttachmentChip, type PendingAttachment } from './ChatAttachmentChip';
import CommandPopup from './CommandPopup';
import ContextMeter from './context-meter';
import { filterByPrefix, isSlashMode, type SlashCommand } from './commands';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (e: FormEvent) => void;
  isPending: boolean;
  /** Stop the in-flight turn — fired by the STOP button shown while pending. */
  onCancel: () => void;
  connectionStatus: ConnectionStatus;
  attachments: PendingAttachment[];
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (localId: string) => void;
  /** Context-window occupancy for the active thread; null until measured. */
  contextUsage: ContextUsage | null;
}

const statusColors: Record<ConnectionStatus, string> = {
  connected: 'bg-green-500',
  connecting: 'bg-yellow-500 animate-pulse',
  disconnected: 'bg-muted-foreground',
  error: 'bg-destructive',
};

export default function ChatInput({
  value,
  onChange,
  onSend,
  isPending,
  onCancel,
  connectionStatus,
  attachments,
  onFilesSelected,
  onRemoveAttachment,
  contextUsage,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  // Slash-command popup state (mirrors the TUI). `dismissed` lets Escape hide
  // the popup without clearing the input; it resets the moment the user types.
  const [commandIndex, setCommandIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const hasReady = attachments.some((a) => a.status === 'ready');
  const isUploading = attachments.some((a) => a.status === 'uploading');
  const isDisabled = (!value.trim() && !hasReady) || isPending || isUploading;

  // Filtered command list shown while typing a leading "/" with no space yet.
  // '/' alone lists everything; '/sk' filters by prefix. Mirrors the TUI's
  // `filterByPrefix(value === '/' ? '/' : value)`.
  const filteredCommands = useMemo<SlashCommand[]>(
    () => (isSlashMode(value) ? filterByPrefix(value) : []),
    [value],
  );
  const showCommandPopup = filteredCommands.length > 0 && !dismissed;

  // Keep the highlight in range as the filtered list shrinks/grows.
  useEffect(() => {
    setCommandIndex((i) => (i >= filteredCommands.length ? 0 : i));
  }, [filteredCommands.length]);

  const handleChange = (next: string) => {
    // Any edit re-opens a popup the user had dismissed with Escape.
    if (dismissed) setDismissed(false);
    onChange(next);
  };

  // Tab / click completes the highlighted command to "<name> " — the trailing
  // space ends slash mode so the popup closes and the user types arguments.
  const completeCommand = (cmd: SlashCommand) => {
    onChange(cmd.name + ' ');
    setDismissed(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommandPopup) {
      const n = filteredCommands.length;
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCommandIndex((i) => (i - 1 + n) % n);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCommandIndex((i) => (i + 1) % n);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const chosen = filteredCommands[commandIndex];
        if (chosen) completeCommand(chosen);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
      // Enter falls through to submit — like the TUI, Enter dispatches the typed
      // command line (the registry resolves it) rather than the highlighted row.
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isDisabled) onSend(e as unknown as FormEvent);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFilesSelected(files);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // Ignore drag-leave bubbling from children.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      onFilesSelected(files);
    }
  };

  const handlePickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length) onFilesSelected(files);
    // Reset so selecting the same file again still fires onChange.
    e.target.value = '';
  };

  return (
    <div className="border-t bg-background">
      {/*
        Meta strip. Previously shown only while disconnected; it now also carries
        the context-window reading, so it renders when either signal is present.
        Connection notice on the left, context on the right; when only one is
        present it still lands on its own side.
      */}
      {(connectionStatus !== 'connected' || contextUsage) && (
        <div className="flex items-center justify-between gap-2 bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            {connectionStatus !== 'connected' && (
              <>
                <span className={`inline-block size-1.5 rounded-full ${statusColors[connectionStatus]}`} />
                {connectionStatus === 'connecting' ? 'Connecting…' : 'Disconnected'}
              </>
            )}
          </span>
          {contextUsage && <ContextMeter usage={contextUsage} />}
        </div>
      )}
      <div
        className="px-4 py-3"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <form onSubmit={onSend}>
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map((a) => (
                <PendingAttachmentChip key={a.localId} attachment={a} onRemove={onRemoveAttachment} />
              ))}
            </div>
          )}
          <div className="relative">
          {showCommandPopup && (
            <CommandPopup
              items={filteredCommands}
              selectedIndex={commandIndex}
              onSelect={completeCommand}
            />
          )}
          <InputGroup className={`h-auto ${isDragging ? 'ring-2 ring-primary ring-offset-1' : ''}`}>
            <InputGroupAddon align="inline-start">
              <span
                className={`inline-block size-2 rounded-full ${statusColors[connectionStatus]}`}
                title={connectionStatus}
              />
              <InputGroupButton
                type="button"
                size="icon-xs"
                variant="ghost"
                onClick={() => fileInputRef.current?.click()}
                title="Attach files"
                aria-label="Attach files"
              >
                <Paperclip className="size-3.5" />
              </InputGroupButton>
            </InputGroupAddon>
            <InputGroupTextarea
              ref={textareaRef}
              value={value}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isDragging ? 'Drop files to attach…' : 'Message your agent...'}
              rows={1}
              className="max-h-40 min-h-[36px]"
            />
            <InputGroupAddon align="inline-end">
              {isPending ? (
                <InputGroupButton
                  type="button"
                  size="icon-xs"
                  // Disabled while disconnected: the cancel can't reach the
                  // runtime, so don't imply the turn was stopped.
                  variant={connectionStatus === 'connected' ? 'default' : 'ghost'}
                  disabled={connectionStatus !== 'connected'}
                  onClick={onCancel}
                  title="Stop response"
                  aria-label="Stop response"
                  data-testid="chat-stop-button"
                  className="rounded-full"
                >
                  <Square className="size-3 fill-current" />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  size="icon-xs"
                  variant={isDisabled ? 'ghost' : 'default'}
                  disabled={isDisabled}
                  className="rounded-full"
                >
                  <ArrowUp className="size-3.5" />
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handlePickFiles}
          />
        </form>
      </div>
    </div>
  );
}

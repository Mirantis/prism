import {
  useRef,
  useEffect,
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
import { ArrowUp, Loader2, Paperclip } from 'lucide-react';
import type { ConnectionStatus } from '@/hooks/use-websocket';
import { PendingAttachmentChip, type PendingAttachment } from './ChatAttachmentChip';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (e: FormEvent) => void;
  isPending: boolean;
  connectionStatus: ConnectionStatus;
  attachments: PendingAttachment[];
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (localId: string) => void;
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
  connectionStatus,
  attachments,
  onFilesSelected,
  onRemoveAttachment,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const hasReady = attachments.some((a) => a.status === 'ready');
  const isUploading = attachments.some((a) => a.status === 'uploading');
  const isDisabled = (!value.trim() && !hasReady) || isPending || isUploading;

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
      {connectionStatus !== 'connected' && (
        <div className="flex items-center justify-center gap-2 bg-muted/50 px-4 py-1.5 text-xs text-muted-foreground">
          <span className={`inline-block size-1.5 rounded-full ${statusColors[connectionStatus]}`} />
          {connectionStatus === 'connecting' ? 'Connecting…' : 'Disconnected'}
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
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={isDragging ? 'Drop files to attach…' : 'Message your agent...'}
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

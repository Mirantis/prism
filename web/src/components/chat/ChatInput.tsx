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
import { ArrowUp, Mic, Paperclip, Square, X } from 'lucide-react';
import type { ConnectionStatus } from '@/hooks/use-websocket';
import type { Dictation } from '@/hooks/use-dictation';
import type { ContextUsage } from '@/types';
import { PendingAttachmentChip, type PendingAttachment } from './ChatAttachmentChip';
import CommandPopup from './CommandPopup';
import ContextMeter from './context-meter';
import DictationBar from './dictation-bar';
import { filterByPrefix, isSlashMode, type SlashCommand } from './commands';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (e: FormEvent) => void;
  isPending: boolean;
  /**
   * Stop the in-flight turn — fired by the STOP button, which appears next to
   * (never in place of) send while pending, so a message can still be sent into
   * the running turn.
   */
  onCancel: () => void;
  connectionStatus: ConnectionStatus;
  attachments: PendingAttachment[];
  onFilesSelected: (files: File[]) => void;
  onRemoveAttachment: (localId: string) => void;
  /** Context-window occupancy for the active thread; null until measured. */
  contextUsage: ContextUsage | null;
  /** A compaction is running for the active thread — show a note in the meta strip. */
  isCompacting?: boolean;
  /** Speaking a message instead of typing it, or nothing when the surface does not offer it. */
  dictation?: Dictation;
  /** Why a voice message cannot be recorded right now, such as a call holding the microphone. */
  dictationBlockedReason?: string | null;
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
  isCompacting = false,
  dictation,
  dictationBlockedReason = null,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cancelDictationRef = useRef<HTMLButtonElement>(null);
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
  // Deliberately not gated on `isPending`: a message sent while the agent is
  // responding is handed to the turn that already owns the thread, which picks
  // it up at its next step. Blocking it here is what kept steering out of the
  // web while Slack and the terminal UI had it.
  //
  // Gated on the connection for the same reason STOP is: the send can't reach
  // the runtime, so don't imply the message went out. `sendMessage()` would
  // early-return on a closed socket while `handleSend` had already cleared the
  // composer and echoed the message locally — the text would be gone and the
  // echo would be a lie. That hole predates steering, but keeping send live for
  // the whole turn is what makes a mid-turn disconnect reachable.
  const isDisabled =
    (!value.trim() && !hasReady) || isUploading || connectionStatus !== 'connected';

  // The button is icon-only, so its tooltip carries the whole explanation. A
  // disconnected composer is inert on every mount and every reconnect, and
  // without this the reason lived only in the meta strip.
  const sendLabel =
    connectionStatus !== 'connected'
      ? 'Not connected'
      : isPending
        ? 'Send — the running turn will pick this up'
        : 'Send message';

  // A dictation takes the text field's place from the press until its words are sent.
  const isDictating = dictation !== undefined && dictation.status !== 'idle';
  // A failed dictation has to be readable text somewhere, and the composer is where the
  // user pressed the button.
  const dictationError = dictation?.error ?? null;

  // The control that was pressed goes away when the composer swaps its contents, so focus
  // goes to the one that takes its place: discard while recording, the text field after.
  const wasDictating = useRef(false);
  useEffect(() => {
    if (isDictating === wasDictating.current) return;
    wasDictating.current = isDictating;
    if (isDictating) cancelDictationRef.current?.focus();
    else textareaRef.current?.focus();
  }, [isDictating]);

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

  // Tab, Enter or a click completes the highlighted command to "<name> " — the
  // trailing space ends slash mode so the popup closes and the user types
  // arguments.
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
      // Enter accepts the highlighted row, the same as Tab, and sends nothing. A
      // second Enter — the popup now closed by the trailing space — sends the
      // command line for the registry to resolve. Shift+Enter still inserts a
      // newline.
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
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

  const dictationTitle =
    connectionStatus !== 'connected' ? 'Not connected' : (dictationBlockedReason ?? 'Voice message');

  // A small round control, the size every button in the composer's toolbar shares.
  const toolButton = 'size-8 rounded-full';

  return (
    <div className="bg-background">
      <div
        className="mx-auto w-full max-w-3xl px-4 pt-2 pb-3 sm:pb-5"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {/* What the composer has to say about itself, above it and only when it has
            something: the connection, a compaction, a voice message that failed. */}
        {(connectionStatus !== 'connected' || isCompacting || dictationError) && (
          <div className="flex items-center gap-3 px-2 pb-1.5 text-xs text-muted-foreground">
            {connectionStatus !== 'connected' && (
              <span className="flex items-center gap-1.5">
                <span className={`inline-block size-1.5 rounded-full ${statusColors[connectionStatus]}`} />
                {connectionStatus === 'connecting' ? 'Connecting…' : 'Disconnected'}
              </span>
            )}
            {isCompacting && (
              <span data-testid="compacting-indicator" className="flex items-center gap-1.5">
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-yellow-500" />
                Compacting conversation…
              </span>
            )}
            {dictationError && (
              <span data-testid="dictation-error" className="text-destructive">
                {dictationError}
              </span>
            )}
          </div>
        )}
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
          {/* One card: what is being written on top, and a toolbar under it — attach on
              the left, everything that acts on the message on the right. */}
          <InputGroup
            className={`h-auto rounded-2xl border-border bg-card shadow-lg dark:bg-card ${
              isDragging ? 'ring-2 ring-primary ring-offset-1' : ''
            }`}
          >
            {dictation && isDictating ? (
              <DictationBar dictation={dictation} />
            ) : (
              <InputGroupTextarea
                ref={textareaRef}
                aria-label="Message your agent"
                value={value}
                onChange={(e) => handleChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder={isDragging ? 'Drop files to attach…' : 'Message your agent...'}
                rows={1}
                className="max-h-48 min-h-[68px] px-5 pt-4 text-[15px] leading-6"
              />
            )}
            <InputGroupAddon align="block-end" className="gap-1 px-2 pb-2">
              {dictation && isDictating ? (
                <InputGroupButton
                  ref={cancelDictationRef}
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className={toolButton}
                  onClick={dictation.cancel}
                  title="Discard voice message"
                  aria-label="Discard voice message"
                  data-testid="dictation-cancel"
                >
                  <X className="size-4" />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className={toolButton}
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach files"
                  aria-label="Attach files"
                >
                  <Paperclip className="size-4" />
                </InputGroupButton>
              )}
              <span className="ml-auto flex items-center gap-1">
                {contextUsage && !isDictating && (
                  <span className="mr-2 text-xs">
                    <ContextMeter usage={contextUsage} />
                  </span>
                )}
                {/*
                  STOP joins send while pending rather than replacing it, so the user can
                  redirect the running turn instead of only killing it. Send keeps the
                  rightmost slot in every state — its hit target must not move out from
                  under the cursor mid-turn — and the microphone sits beside it, after
                  STOP, so it keeps its place when a turn starts.
                */}
                {isPending && (
                  <InputGroupButton
                    type="button"
                    size="icon-sm"
                    // Disabled while disconnected: the cancel can't reach the
                    // runtime, so don't imply the turn was stopped.
                    variant={connectionStatus === 'connected' ? 'default' : 'ghost'}
                    disabled={connectionStatus !== 'connected'}
                    onClick={onCancel}
                    title="Stop response"
                    aria-label="Stop response"
                    data-testid="chat-stop-button"
                    className={toolButton}
                  >
                    <Square className="size-3 fill-current" />
                  </InputGroupButton>
                )}
                {dictation && !isDictating && (
                  // The reason sits on a wrapper: a disabled button takes no pointer
                  // events, so a title of its own would never show.
                  <span className="inline-flex" title={dictationTitle} data-testid="dictation-button-hint">
                    <InputGroupButton
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className={toolButton}
                      disabled={connectionStatus !== 'connected' || dictationBlockedReason !== null}
                      onClick={dictation.start}
                      aria-label="Voice message"
                      aria-description={dictationTitle === 'Voice message' ? undefined : dictationTitle}
                      data-testid="dictation-button"
                    >
                      <Mic className="size-4" />
                    </InputGroupButton>
                  </span>
                )}
                {dictation && isDictating ? (
                  // The send slot stays where it is, so a recording is sent from the same
                  // place a typed message is.
                  <InputGroupButton
                    type="button"
                    size="icon-sm"
                    variant={dictation.status === 'recording' ? 'default' : 'ghost'}
                    disabled={dictation.status !== 'recording'}
                    onClick={dictation.send}
                    title="Send voice message"
                    aria-label="Send voice message"
                    data-testid="dictation-send"
                    className={toolButton}
                  >
                    <ArrowUp className="size-4" />
                  </InputGroupButton>
                ) : (
                  <InputGroupButton
                    type="submit"
                    size="icon-sm"
                    variant={isDisabled ? 'secondary' : 'default'}
                    disabled={isDisabled}
                    title={sendLabel}
                    aria-label={sendLabel}
                    className={toolButton}
                  >
                    <ArrowUp className="size-4" />
                  </InputGroupButton>
                )}
              </span>
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
        <p className="mt-2.5 text-center text-[11px] text-muted-foreground">
          <span className="hidden sm:inline">Enter to send · Shift + Enter for a new line · </span>Type / for commands
        </p>
      </div>
    </div>
  );
}

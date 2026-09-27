import { ChatComputerHelp } from '@/components/computer/chat-computer-help';
import { computerHelpBlocks } from '@/types';
import { memo } from 'react';
import { CopyButton } from '@/components/shared/copy-button';
import AgentAvatar from './agent-avatar';
import ParticipantAvatar from './participant-avatar';
import ChatMarkdown from './ChatMarkdown';
import ChatToolCalls from './ChatToolCalls';
import { MessageAttachmentChip } from './ChatAttachmentChip';
import type { TranscriptMessage } from '@/lib/chat-socket/transcript';
import type { ConversationMessage } from '@/types';

function AttachmentChips({ message }: { message: ConversationMessage }) {
  if (!message.attachments || message.attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {message.attachments.map((a) => (
        <MessageAttachmentChip key={a.id} attachment={a} />
      ))}
    </div>
  );
}

interface ChatMessageProps {
  message: TranscriptMessage;
  agentName: string;
  /**
   * The name this connection signed in as. A USER message by anyone else shows its
   * sender. Undefined until the runtime has said, and then every message is drawn as
   * our own: the runtime stamps our messages with our name, and read as somebody
   * else's they would jump sides when the socket opened.
   */
  viewerName: string | null | undefined;
  onOpenComputerHelp: (id: string) => void;
  /** Send a failed message again. */
  onRetry: (id: string) => void;
  /** Take a failed message back into the composer. */
  onEdit: (id: string) => void;
}

/** A message rises into place as it arrives. */
const ENTER = 'animate-in fade-in-0 slide-in-from-bottom-1 duration-300 ease-out';

const ChatMessage = memo(function ChatMessage({
  message,
  agentName,
  viewerName,
  onOpenComputerHelp,
  onRetry,
  onEdit,
}: ChatMessageProps) {
  const isError = message.role === 'SYSTEM' && message.id.startsWith('error-');
  const time = new Date(message.createdAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (message.role === 'SYSTEM') {
    // A one-line note ("Running skill…") reads as an aside: centered, italic,
    // out of the way. Anything multi-line is structured output from a slash
    // command — a list of plugins, skills, goals — and centering or
    // italicizing that makes it unreadable, so it gets a normal block.
    const isBlock = message.content.trim().includes('\n');
    // Built as one non-overlapping set rather than layered conditionals: two
    // competing `bg-*`/`border-*` classes on the same element resolve by
    // stylesheet order, not by which appears last in the string.
    const shape = isBlock ? 'w-full text-left' : 'text-center italic';
    const skin = isError
      ? 'border border-destructive/40 bg-destructive/10 text-destructive'
      : isBlock
        ? 'border bg-card text-foreground'
        : 'bg-muted/25 text-muted-foreground';
    return (
      <div className={`flex ${ENTER} ${isBlock ? 'justify-start' : 'justify-center'}`}>
        <div className={`max-w-[85%] rounded-xl px-4 py-2 text-sm ${shape} ${skin}`}>
          <ChatMarkdown content={message.content} />
        </div>
      </div>
    );
  }

  const hasText = message.content.trim().length > 0;
  const sender =
    message.role === 'USER' && viewerName !== undefined && message.senderName && message.senderName !== viewerName
      ? message.senderName
      : null;

  // Somebody else sharing the agent: on the left with everyone who is not this
  // person, laid out like the agent's replies, in a bubble that never passes for
  // our own.
  if (sender) {
    return (
      <div className={`group flex gap-3 ${ENTER}`} data-message-role="participant">
        <ParticipantAvatar name={sender} className="mt-0.5" />
        <div className="flex max-w-[85%] min-w-0 flex-col items-start gap-2">
          <div className="flex h-7 items-center gap-2">
            <span className="text-sm font-medium text-strong" data-testid="message-sender">
              {sender}
            </span>
            <span className="text-[11px] text-muted-foreground">{time}</span>
          </div>
          <AttachmentChips message={message} />
          {hasText && (
            <div className="max-w-full overflow-hidden rounded-2xl rounded-tl-md bg-muted px-4 py-2.5 text-[15px] break-words text-foreground [&_:not(pre)>code]:bg-background/70">
              <ChatMarkdown content={message.content} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.role === 'USER') {
    return (
      <div className={`group flex justify-end gap-3 ${ENTER}`} data-message-role="user" data-delivery={message.delivery}>
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          <AttachmentChips message={message} />
          {hasText && (
            <div className="rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[15px] text-primary-foreground shadow-md shadow-primary/15 [&_a]:text-primary-foreground [&_a]:decoration-primary-foreground/50">
              <ChatMarkdown content={message.content} />
            </div>
          )}
          {message.delivery === 'failed' ? (
            <span className="flex items-center gap-2 px-1 text-[11px] text-destructive" data-testid="message-failed">
              {message.deliveryError ?? 'The message could not be sent.'}
              <button
                type="button"
                onClick={() => onRetry(message.id)}
                className="font-medium hover:underline"
                data-testid="message-retry"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => onEdit(message.id)}
                className="font-medium hover:underline"
                data-testid="message-edit"
              >
                Edit
              </button>
            </span>
          ) : (
            <span className="px-1 text-[11px] text-muted-foreground">{time}</span>
          )}
        </div>
      </div>
    );
  }

  const help = computerHelpBlocks(message);
  return (
    <div className={`group flex gap-3 ${ENTER}`} data-message-role="agent">
      <AgentAvatar className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex h-7 items-center gap-2">
          <span className="text-sm font-medium text-strong">{agentName}</span>
          <span className="text-[11px] text-muted-foreground">{time}</span>
        </div>
        {/* A bubble like every other participant's, the full width of the column so
            tables and code keep their room. */}
        {help.length === 0 && message.content.trim() && (
          <div className="overflow-hidden rounded-2xl rounded-tl-md bg-muted px-4 py-3 text-[15px] leading-relaxed break-words text-foreground [&_:not(pre)>code]:bg-background/70">
            <ChatMarkdown content={message.content} />
          </div>
        )}
        {help.map((item) => (
          <ChatComputerHelp key={item.id} help={item} onOpen={onOpenComputerHelp} />
        ))}
        <AttachmentChips message={message} />
        {message.toolCalls && message.toolCalls.length > 0 && <ChatToolCalls toolCalls={message.toolCalls} />}
        {help.length === 0 && message.content.trim() && (
          // Shown on hover and on keyboard focus, so it stays out of the way of reading; always
          // shown on a touch screen, which has no hover.
          <div className="-ml-1.5 flex h-7 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            <CopyButton text={message.content} label="Copy reply" testId="message-copy" />
          </div>
        )}
      </div>
    </div>
  );
});

export default ChatMessage;

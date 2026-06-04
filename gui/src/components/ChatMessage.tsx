import type { ConversationMessage } from '../lib/runtime';
import { Markdown } from './Markdown';
import { ToolCalls } from './ToolCalls';

const ROLE_LABEL: Record<ConversationMessage['role'], string> = {
  USER: 'You',
  AGENT: 'Agent',
  SYSTEM: 'System',
};

export function ChatMessage({ message }: { message: ConversationMessage }) {
  const role = message.role.toLowerCase();
  return (
    <div className={`message message-${role}`}>
      <div className="message-role">{ROLE_LABEL[message.role]}</div>
      <div className="message-body">
        {message.role === 'USER' ? (
          <div className="message-text">{message.content}</div>
        ) : (
          <Markdown content={message.content} />
        )}
        {message.toolCalls && message.toolCalls.length > 0 ? (
          <ToolCalls toolCalls={message.toolCalls} />
        ) : null}
      </div>
    </div>
  );
}

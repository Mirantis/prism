import { useChat } from '../hooks/use-chat';
import { ChatMessageList } from './ChatMessageList';
import { ChatInput } from './ChatInput';

const CONNECTION_LABEL: Record<ReturnType<typeof useChat>['connection'], string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected — retrying…',
};

export function Chat() {
  const { messages, status, statusDetail, connection, send } = useChat();

  return (
    <div className="chat">
      <header className="chat-header">
        <h1>Chat</h1>
        <span className={`connection connection-${connection}`}>
          {CONNECTION_LABEL[connection]}
        </span>
      </header>

      <ChatMessageList messages={messages} status={status} />

      {status === 'error' && statusDetail ? (
        <div className="chat-error">{statusDetail}</div>
      ) : null}

      <ChatInput onSend={send} disabled={status === 'thinking'} />
    </div>
  );
}

/**
 * The JSON the eval set exchanges with `prism-server eval`, as the backend reads and
 * writes it (camelCase field names, lowercase enum values).
 */

export type ChatPlatform = 'slack' | 'teams';

export type ModelTier = 'small' | 'medium' | 'large';

export interface AttachmentMeta {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  category: 'image' | 'pdf' | 'text' | 'unreadable';
  expired: boolean;
}

/** Another agent of the project that sent a message, and how it sent it. */
export interface AgentMessageOrigin {
  kind: 'message' | 'ask' | 'notice';
  senderId: string;
  senderName: string;
  messageId: string;
}

export interface GateAgent {
  name: string;
  role: string;
}

export interface ThreadLine {
  author: { kind: 'agent' | 'bot' | 'person'; name: string };
  text: string;
}

/** A place a message can be sent to: a linked chat's DM or channel. */
export interface LinkedTarget {
  key: string;
  platform: ChatPlatform;
  kind: 'dm' | 'channel';
  conversationId: string;
  name: string | null;
  isMain: boolean;
  dmUserId?: string;
}

/** Where a heartbeat, unbound scheduled-task or webhook run may post. */
export interface PostingCeiling {
  webChat: boolean;
  targets: LinkedTarget[];
}

/** The channel messages that started a heartbeat. */
export interface HeartbeatTrigger {
  platform: string;
  place?: { target: string; name: string };
  messages: { sender: string; text: string; timestamp: string }[];
}

/** What a recurring task's earlier runs sent, as the scheduler gives an unbound run. */
export interface TaskLastSend {
  messages: string;
  at: number;
  latestReport?: { text: string; at: number };
  reports?: { text: string; at: number }[];
}

/** A tool a host adds beside the built-ins, such as a connector's. */
export interface ToolDefinition {
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** The size of the prompt, in characters. */
export interface PromptSize {
  /** The chat system prompt without the identity documents. */
  productText: number;
  /** The identity documents a new agent is seeded with. */
  seededTemplates: number;
  /** The built-in tools' descriptions, the tool's and its parameters'. */
  toolDescriptions: number;
}

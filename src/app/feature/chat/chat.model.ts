import type { PaginatedData } from '../../shared/models/pagination.model';

/** A link to workspace context associated with a conversation. */
export interface Anchor {
  label: string;
  link: string;
}

export interface ChatMessage {
  content: string;
  role: 'user' | 'assistant';
  /** Unix timestamp in milliseconds. */
  createdAt: number;
}

export interface ChatMessageStream {
  chatId: string;
  content: string;
  finished: boolean;
  reason: string | null;
}

export type ChatCategory = 'assistance' | 'tutoring' | null;

export interface Chat {
  id: string | null;
  title: string | null;
  goal: string | null;
  category: ChatCategory;
  messages: PaginatedData<ChatMessage>;
  anchors: Anchor[];
  /** Unix timestamp in milliseconds. */
  updatedAt: number;
}

export interface ChatSummary {
  id: string;
  title: string | null;
  category: ChatCategory;
  /** Unix timestamp in milliseconds. */
  updatedAt: number;
}

export type ChatMetadata = Omit<Chat, 'messages'>;

export type ChatStream = Omit<Chat, 'goal' | 'anchors'>;

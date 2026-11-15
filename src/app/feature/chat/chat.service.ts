import { Injectable, computed, signal } from '@angular/core';
import type {
  Anchor,
  Chat,
  ChatCategory,
  ChatMessage,
  ChatSummary,
} from './chat.model';

const EMPTY_MESSAGES: Chat['messages'] = {
  data: [],
  meta: { nextCursor: null, hasMore: false, limit: 0 },
};

@Injectable({ providedIn: 'root' })
export class ChatService {
  private readonly _chats = signal<Chat[]>([]);

  /** Full chat records, in most recently updated first order. */
  readonly chats = this._chats.asReadonly();

  /** Lightweight list for chat pickers and history menus. */
  readonly chatList = computed<ChatSummary[]>(() =>
    this._chats().flatMap(({ id, title, category, updatedAt }) =>
      id ? [{ id, title, category, updatedAt }] : [],
    ),
  );

  getChatById(id: string): Chat | undefined {
    return this._chats().find((chat) => chat.id === id);
  }

  createChat(data: {
    title?: string | null;
    goal?: string | null;
    category?: ChatCategory;
    anchors?: Anchor[];
  } = {}): Chat {
    const chat: Chat = {
      id: crypto.randomUUID(),
      title: data.title?.trim() || null,
      goal: data.goal ?? null,
      category: data.category ?? null,
      messages: { ...EMPTY_MESSAGES, data: [] },
      anchors: data.anchors ? [...data.anchors] : [],
      updatedAt: Date.now(),
    };

    this._chats.update((chats) => [chat, ...chats]);
    return chat;
  }

  forkChat(id: string): Chat | undefined {
    const source = this.getChatById(id);
    if (!source) return undefined;

    const fork: Chat = {
      ...source,
      id: crypto.randomUUID(),
      title: source.title ? `${source.title} (fork)` : 'Forked chat',
      messages: {
        ...source.messages,
        data: source.messages.data.map((message) => ({ ...message })),
      },
      anchors: source.anchors.map((anchor) => ({ ...anchor })),
      updatedAt: Date.now(),
    };

    this._chats.update((chats) => [fork, ...chats]);
    return fork;
  }

  updateChat(id: string, updates: Partial<Omit<Chat, 'id' | 'updatedAt'>>): void {
    this._updateChat(id, (chat) => ({ ...chat, ...updates }));
  }

  updateChatTitle(id: string, title: string | null): void {
    this._updateChat(id, (chat) => ({ ...chat, title: title?.trim() || null }));
  }

  deleteChat(id: string): void {
    this._chats.update((chats) => chats.filter((chat) => chat.id !== id));
  }

  addMessage(
    chatId: string,
    message: Omit<ChatMessage, 'createdAt'> & { createdAt?: number },
  ): ChatMessage | undefined {
    const chat = this.getChatById(chatId);
    if (!chat) return undefined;

    const newMessage: ChatMessage = {
      ...message,
      createdAt: message.createdAt ?? Date.now(),
    };
    this._updateChat(chatId, (current) => ({
      ...current,
      messages: {
        ...current.messages,
        data: [...current.messages.data, newMessage],
      },
    }));
    return newMessage;
  }

  updateMessage(chatId: string, messageIndex: number, content: string): void {
    this._updateChat(chatId, (chat) => {
      if (!chat.messages.data[messageIndex]) return chat;
      return {
        ...chat,
        messages: {
          ...chat.messages,
          data: chat.messages.data.map((message, index) =>
            index === messageIndex ? { ...message, content } : message,
          ),
        },
      };
    });
  }

  deleteMessage(chatId: string, messageIndex: number): void {
    this._updateChat(chatId, (chat) => ({
      ...chat,
      messages: {
        ...chat.messages,
        data: chat.messages.data.filter((_, index) => index !== messageIndex),
      },
    }));
  }

  setAnchors(chatId: string, anchors: Anchor[]): void {
    this._updateChat(chatId, (chat) => ({ ...chat, anchors: [...anchors] }));
  }

  addAnchor(chatId: string, anchor: Anchor): void {
    const chat = this.getChatById(chatId);
    if (!chat) return;
    this.setAnchors(chatId, [...chat.anchors, anchor]);
  }

  removeAnchor(chatId: string, index: number): void {
    const chat = this.getChatById(chatId);
    if (!chat) return;
    this.setAnchors(
      chatId,
      chat.anchors.filter((_, anchorIndex) => anchorIndex !== index),
    );
  }

  clear(): void {
    this._chats.set([]);
  }

  private _updateChat(id: string, update: (chat: Chat) => Chat): void {
    this._chats.update((chats) => {
      const index = chats.findIndex((chat) => chat.id === id);
      if (index < 0) return chats;

      const next = [...chats];
      next[index] = { ...update(chats[index]), updatedAt: Date.now() };
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      return next;
    });
  }
}

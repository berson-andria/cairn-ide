import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ChatService } from '../../chat.service';
import { ChatHistoryItem } from '../history-item/chat-history-item';

@Component({
  selector: 'app-chat-history',
  standalone: true,
  imports: [ChatHistoryItem],
  templateUrl: './chat-history.html',
  styleUrl: './chat-history.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatHistory {
  readonly chatService = inject(ChatService);
  readonly search = signal('');
  readonly filteredChats = computed(() => {
    const query = this.search().trim().toLocaleLowerCase();
    const chats = this.chatService.chatList();
    return query
      ? chats.filter((chat) => (chat.title ?? 'New chat').toLocaleLowerCase().includes(query))
      : chats;
  });
}

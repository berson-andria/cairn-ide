import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';
import { TabStore } from '../../core/store/tab.store';
import { ChatService } from './chat.service';
import { Message } from './component/message/message';
import { MessageInput } from './component/message-input/message-input';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [Message, MessageInput],
  templateUrl: './chat.html',
  styleUrl: './chat.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Chat {
  readonly chatId = input.required<string>();
  private readonly chatService = inject(ChatService);
  private readonly tabStore = inject(TabStore);

  readonly chat = computed(() => this.chatService.getChatById(this.chatId()));

  constructor() {
    effect(() => {
      const title = this.chat()?.title;
      if (title) this.tabStore.updateTab(this.chatId(), { title });
    });
  }
}

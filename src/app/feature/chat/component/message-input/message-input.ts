import { Component, inject, input } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowUp } from '@ng-icons/lucide';

import { AutoExpandDirective } from '../../../../shared/directives/auto-expand';
import { ChatService } from '../../chat.service';

@Component({
  selector: 'message-input',
  imports: [AutoExpandDirective, NgIcon, ReactiveFormsModule],
  templateUrl: './message-input.html',
  styleUrl: './message-input.scss',
  providers: [provideIcons({ lucideArrowUp })],
})
export class MessageInput {
  readonly chatId = input.required<string>();
  private readonly chatService = inject(ChatService);
  queryController = new FormControl('', [Validators.required]);

  get canSend(): boolean {
    return this.queryController.valid && !!this.queryController.value?.trim();
  }

  sendQuery() {
    if (this.canSend) {
      const content = this.queryController.value!.trim();
      const chatId = this.chatId();
      const chat = this.chatService.getChatById(chatId);

      this.chatService.addMessage(chatId, { content, role: 'user' });
      if (!chat?.title) {
        this.chatService.updateChatTitle(chatId, content.slice(0, 56));
      }
      this.queryController.reset();
    }
  }
}

import { Component, computed, inject, input, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePaperclip, lucideSend, lucideX } from '@ng-icons/lucide';

import { LayoutService } from '../../../../core/services/layout.service';
import { AutoExpandDirective } from '../../../../shared/directives/auto-expand';
import { NoteService } from '../../../notes/note.service';
import { TaskService } from '../../../tasks/task.service';
import type { ChatGoal } from '../../chat.model';
import { ChatService } from '../../chat.service';

@Component({
  selector: 'message-input',
  imports: [AutoExpandDirective, NgIcon, ReactiveFormsModule],
  templateUrl: './message-input.html',
  styleUrl: './message-input.scss',
  providers: [provideIcons({ lucideSend, lucidePaperclip, lucideX })],
})
export class MessageInput {
  readonly chatId = input.required<string>();
  readonly selectedGoal = signal<ChatGoal | null>(null);
  private readonly chatService = inject(ChatService);
  private readonly layoutService = inject(LayoutService);
  private readonly noteService = inject(NoteService);
  private readonly taskService = inject(TaskService);
  readonly chat = computed(() => this.chatService.getChatById(this.chatId()));
  queryController = new FormControl('', [Validators.required]);

  get canSend(): boolean {
    return this.queryController.valid && !!this.queryController.value?.trim();
  }

  sendQuery() {
    if (this.canSend) {
      const content = this.queryController.value!.trim();
      const chatId = this.chatId();
      const chat = this.chatService.getChatById(chatId);

      this.chatService.addMessage(chatId, {
        content,
        role: 'user',
        ...(this.selectedGoal() ? { goal: this.selectedGoal()! } : {}),
      });
      if (!chat?.title) {
        this.chatService.updateChatTitle(chatId, content.slice(0, 56));
      }
      this.queryController.reset();
    }
  }

  setGoal(goal: ChatGoal): void {
    this.selectedGoal.update((current) => (current === goal ? null : goal));
  }

  async attachContext(): Promise<void> {
    const selected = await this.layoutService.openAnchor({ kind: 'file' });
    if (!selected) return;

    if (selected.kind === 'file') {
      const label = selected.path.split(/[\\/]/).pop() || selected.path;
      this.chatService.addAnchor(this.chatId(), {
        label,
        link: `file:${selected.path}`,
      });
    } else if (selected.kind === 'task') {
      const task = this.taskService.get(selected.id);
      this.chatService.addAnchor(this.chatId(), {
        label: task?.title ?? 'Task',
        link: `task:${selected.id}`,
      });
    } else {
      const note = this.noteService.get(selected.id);
      this.chatService.addAnchor(this.chatId(), {
        label: note?.content.slice(0, 48) || 'Note',
        link: `note:${selected.id}`,
      });
    }
  }

  removeAnchor(index: number): void {
    this.chatService.removeAnchor(this.chatId(), index);
  }
}

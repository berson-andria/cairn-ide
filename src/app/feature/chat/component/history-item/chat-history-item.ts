import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEllipsis, lucideGitFork, lucidePencil, lucideTrash2 } from '@ng-icons/lucide';
import { TabStore } from '../../../../core/store/tab.store';
import { MenuDirective } from '../../../../shared/directives/menu.directive';
import type { ChatSummary } from '../../chat.model';
import { ChatService } from '../../chat.service';

@Component({
  selector: 'app-chat-history-item',
  standalone: true,
  imports: [MenuDirective, NgIcon],
  templateUrl: './chat-history-item.html',
  styleUrl: './chat-history-item.scss',
  providers: [provideIcons({ lucideEllipsis, lucideGitFork, lucidePencil, lucideTrash2 })],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChatHistoryItem {
  readonly chat = input.required<ChatSummary>();
  readonly menuOpen = signal(false);
  readonly renaming = signal(false);
  readonly draftTitle = signal('');

  private readonly chatService = inject(ChatService);
  private readonly tabStore = inject(TabStore);

  readonly isActive = computed(() => this.tabStore.activeTabId() === this.chat().id);

  openChat(): void {
    const chat = this.chat();
    this.tabStore.openChat(chat.id, chat.title ?? 'New chat');
  }

  beginRename(): void {
    this.draftTitle.set(this.chat().title ?? '');
    this.renaming.set(true);
  }

  saveRename(): void {
    if (!this.renaming()) return;
    const title = this.draftTitle().trim();
    if (title) this.chatService.updateChatTitle(this.chat().id, title);
    this.renaming.set(false);
  }

  cancelRename(): void {
    this.renaming.set(false);
  }

  deleteChat(): void {
    const chat = this.chat();
    if (!window.confirm(`Delete “${chat.title ?? 'New chat'}”? This cannot be undone.`)) return;
    this.chatService.deleteChat(chat.id);
    this.tabStore.closeTab(chat.id);
  }

  forkChat(): void {
    const fork = this.chatService.forkChat(this.chat().id);
    if (fork?.id) this.tabStore.openChat(fork.id, fork.title ?? 'Forked chat');
  }
}

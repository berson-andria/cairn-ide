import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCopy } from '@ng-icons/lucide';
import type { ChatMessage } from '../../chat.model';

@Component({
  selector: 'app-message',
  standalone: true,
  imports: [DatePipe, NgIcon],
  templateUrl: './message.html',
  styleUrl: './message.scss',
  providers: [provideIcons({ lucideCheck, lucideCopy })],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Message {
  readonly message = input.required<ChatMessage>();
  readonly copied = signal(false);

  async copyMessage(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.message().content);
      this.copied.set(true);
      window.setTimeout(() => this.copied.set(false), 1400);
    } catch {
      this.copied.set(false);
    }
  }
}

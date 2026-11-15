import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ChatMessage } from '../../chat.model';

@Component({
  selector: 'app-message',
  standalone: true,
  templateUrl: './message.html',
  styleUrl: './message.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Message {
  readonly message = input.required<ChatMessage>();
}

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
}

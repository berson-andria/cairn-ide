import { Component, inject } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideHistory,
  lucideMaximize,
  lucidePlus,
  lucideSettings,
  lucideX,
} from '@ng-icons/lucide';
import { MessageInput } from './message-input/message-input';
import { LayoutService } from '../../core/services/layout.service';

@Component({
  selector: 'ai-chat-panel',
  templateUrl: './ai-chat.html',
  styleUrl: './ai-chat.scss',
  imports: [MessageInput, NgIcon],
  providers: [provideIcons({ lucideMaximize, lucideSettings, lucideHistory, lucideX, lucidePlus })],
})
export class AIChatPanel {
  layoutService = inject(LayoutService);
}

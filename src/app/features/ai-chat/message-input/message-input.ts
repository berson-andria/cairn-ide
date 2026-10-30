import { Component } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { AutoExpandDirective } from '../../../shared/directives/auto-expand';
import { lucideArrowUp, lucideMic, lucidePlus } from '@ng-icons/lucide';
import { NgIcon, provideIcons } from '@ng-icons/core';

@Component({
  selector: 'message-input',
  imports: [AutoExpandDirective, ReactiveFormsModule, NgIcon],
  templateUrl: './message-input.html',
  styleUrl: './message-input.scss',
  providers: [provideIcons({ lucidePlus, lucideMic, lucideArrowUp })],
})
export class MessageInput {
  queryController = new FormControl('', [Validators.required]);

  sendQuery() {
    if (this.queryController.valid) {
      this.queryController.reset();
    }
  }
}

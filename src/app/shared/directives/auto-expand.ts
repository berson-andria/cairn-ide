import { Directive, ElementRef, output } from '@angular/core';

@Directive({
  selector: 'textarea[autoExpand]',
  host: {
    '(keydown.enter)': 'onEnter($event)',
    '(input)': 'onInput()',
  },
})
export class AutoExpandDirective {
  submit = output();
  private readonly maxHeight = 160;

  constructor(private el: ElementRef<HTMLTextAreaElement>) {}

  onEnter(event: Event) {
    const kbEvent = event as KeyboardEvent;
    if (!kbEvent.shiftKey) {
      kbEvent.preventDefault();
      this.el.nativeElement.style.height = 'auto';
      this.submit.emit();
    }
  }

  onInput(): void {
    const textarea = this.el.nativeElement;
    textarea.style.height = 'auto'; // reset
    textarea.style.height =
      Math.min(textarea.scrollHeight, this.maxHeight) + 'px';
  }
}

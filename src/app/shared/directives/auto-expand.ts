import { AfterViewInit, Directive, ElementRef, input, output } from '@angular/core';

@Directive({
  selector: 'textarea[autoExpand]',
  host: {
    '(keydown.enter)': 'onEnter($event)',
    '(input)': 'onInput()',
  },
})
export class AutoExpandDirective implements AfterViewInit {
  submit = output();
  autoExpandSubmitOnEnter = input(true);
  autoExpandMaxHeight = input<number | null>(160);

  constructor(private el: ElementRef<HTMLTextAreaElement>) {}

  ngAfterViewInit(): void {
    this.onInput();
  }

  onEnter(event: Event) {
    const kbEvent = event as KeyboardEvent;
    if (!this.autoExpandSubmitOnEnter()) return;
    if (!kbEvent.shiftKey) {
      kbEvent.preventDefault();
      this.el.nativeElement.style.height = 'auto';
      this.submit.emit();
    }
  }

  onInput(): void {
    const textarea = this.el.nativeElement;
    textarea.style.height = 'auto'; // reset
    const maxHeight = this.autoExpandMaxHeight();
    const height =
      maxHeight === null ? textarea.scrollHeight : Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${height}px`;
  }
}

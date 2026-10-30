import { Pipe, PipeTransform } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Pipe({
  name: 'highlight',
  standalone: true,
})
export class HighlightPipe implements PipeTransform {
  constructor(private sanitizer: DomSanitizer) {}

  transform(text: string, search: string): SafeHtml | string {
    if (!text) return '';
    if (!search || !search.trim()) return text;

    try {
      const escapedSearch = search.replace(/[-\/\\^\$*+?.()|[\]{}]/g, '\\$&');

      const regex = new RegExp(`(${escapedSearch})`, 'gi');

      const highlightedText = text.replace(regex, '<mark class="custom-highlight">\$1</mark>');

      return this.sanitizer.bypassSecurityTrustHtml(highlightedText);
    } catch (e) {
      return text;
    }
  }
}

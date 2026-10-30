import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'textWindow',
  standalone: true,
})
export class TextWindowPipe implements PipeTransform {
  transform(text: string, search: string, maxChars = 100): string {
    if (!text) return '';
    if (!search || !search.trim() || text.length <= maxChars) {
      return text.length > maxChars ? text.substring(0, maxChars) + '...' : text;
    }

    try {
      const escapedSearch = search.replace(/[-\/\\^\$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp(escapedSearch, 'i');
      const matchIndex = text.search(regex);

      if (matchIndex === -1) {
        return text.substring(0, maxChars) + '...';
      }

      const halfWindow = Math.floor(maxChars / 2);
      let start = Math.max(0, matchIndex - halfWindow);
      let end = Math.min(text.length, matchIndex + search.length + halfWindow);

      // Adjust boundaries if clicking against edges
      if (start === 0) {
        end = Math.min(text.length, maxChars);
      } else if (end === text.length) {
        start = Math.max(0, text.length - maxChars);
      }

      const sliced = text.substring(start, end);
      const prefix = start > 0 ? '...' : '';
      const suffix = end < text.length ? '...' : '';

      return prefix + sliced + suffix;
    } catch (e) {
      return text.substring(0, maxChars) + '...';
    }
  }
}

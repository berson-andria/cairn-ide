import { Pipe, PipeTransform } from '@angular/core';
// Adjust to where you keep shared utils (next to node.utils).
import { buildSearchSnippet } from '../utils/replace.utils';

/**
 * {{ line.text | searchSnippet: keyword }}   ->   HTML for [innerHTML]
 * Windows the line around the matches, highlights them and escapes everything else, in one step.
 */
@Pipe({ name: 'searchSnippet', standalone: true })
export class SearchSnippetPipe implements PipeTransform {
  transform(text: string, query: string | RegExp | null, context = 40): string {
    return buildSearchSnippet(text ?? '', query ?? '', context);
  }
}

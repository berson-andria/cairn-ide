import { Pipe, PipeTransform } from '@angular/core';
// Adjust to where you keep shared utils (next to node.utils).
import { buildReplacePreview, escapeHtml } from '../utils/replace.utils';

/**
 * {{ line.text | replacePreview: pattern : replacement }}
 * Output is an HTML string for [innerHTML]: matches as <del>old</del><ins>new</ins>, everything else escaped.
 * Pure on purpose: it only recomputes when the line, the pattern or the replacement changes.
 */
@Pipe({ name: 'replacePreview', standalone: true })
export class ReplacePreviewPipe implements PipeTransform {
  transform(text: string, re: RegExp | null, replacement: string): string {
    return re ? buildReplacePreview(text, re, replacement ?? '') : escapeHtml(text);
  }
}

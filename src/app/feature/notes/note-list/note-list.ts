import { Component, inject } from '@angular/core';
import { NodeStore } from '../../../core/store/node.store';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { LayoutService } from '../../../core/services/layout.service';

@Component({
  selector: 'note-list',
  templateUrl: './note-list.html',
  styleUrl: './note-list.scss',
  imports: [NgIcon],
  providers: [provideIcons({ bootstrapChevronDown, bootstrapChevronRight })],
  host: { '[style.flex]': 'layoutService.isRailSectionActive("Notes")? 1: "none"' },
})
export class NoteList {
  readonly nodeStore = inject(NodeStore);
  readonly layoutService = inject(LayoutService);
}

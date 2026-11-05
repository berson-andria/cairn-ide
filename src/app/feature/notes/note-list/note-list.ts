import { Component, inject } from '@angular/core';
import { WorkspaceNodeStore } from '../../../core/store/workspace/workspace.store';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { LayoutService } from '../../../layout/layout-service';

@Component({
  selector: 'note-list',
  templateUrl: './note-list.html',
  styleUrl: './note-list.scss',
  imports: [NgIcon],
  providers: [provideIcons({ bootstrapChevronDown, bootstrapChevronRight })],
  host: { '[style.flex]': 'layoutService.isRailSectionActive("Notes")? 1: "none"' },
})
export class NoteList {
  readonly nodeStore = inject(WorkspaceNodeStore);
  readonly layoutService = inject(LayoutService);
}

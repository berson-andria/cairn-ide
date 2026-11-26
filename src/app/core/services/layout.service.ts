import { inject, Injectable, signal } from '@angular/core';
import { Search } from '../../feature/search/search';
import { DialogService } from './dialog/dialog.service';
import { GitBranchComponent } from '../../feature/git/features/branch/branch';
import { PickerService } from '../../shared/components/anchor-picker/picker.service';
import type { PickResult } from '../../shared/components/anchor-picker/picker.model';
import { NodeStore } from '../store/node.store';
import { samePath } from './file-system/external-watcher.utils';
import { Settings } from '../../feature/setting/settings';

export type RailSection = 'Work' | 'Files' | 'Notes' | 'Changes';
export type Toolkit = 'Terminal' | 'Git' | 'Log' | 'Problems';

@Injectable({
  providedIn: 'root',
})
export class LayoutService {
  readonly activeRail = signal<RailSection>('Files');
  readonly activeToolkit = signal<Toolkit>('Problems');
  readonly dialogService = inject(DialogService);
  private readonly picker = inject(PickerService);
  private readonly nodeStore = inject(NodeStore);

  readonly isBottomPanelCollapsed = signal(false);
  readonly isLefPanelCollapsed = signal(false);

  toggleRailSection(section: RailSection) {
    if (this.isLefPanelCollapsed()) {
      this.isLefPanelCollapsed.set(false);
    }
    this.activeRail.set(section);
  }
  toggleLeftPanel() {
    this.isLefPanelCollapsed.update((v) => !v);
  }

  openGitBranch() {
    this.dialogService.open(GitBranchComponent);
  }

  isRailSectionActive(section: RailSection) {
    return this.activeRail() === section;
  }

  toggleToolkit(section: Toolkit) {
    this.activeToolkit.set(section);
  }

  /** Opens the picker using the allowed sources for its origin and returns the selected entity. */
  async openAnchor(
    opener:
      | { kind: 'task'; id?: string }
      | { kind: 'note'; id?: string }
      | { kind: 'file'; path?: string },
  ): Promise<PickResult | undefined> {
    switch (opener.kind) {
      case 'task':
        return this.picker.forTask(opener.id);
      case 'note':
        return this.picker.forNote(opener.id);
      case 'file': {
        const selected = await this.picker.forFile(opener.path);
        if (selected?.kind !== 'file') return selected;
        const node = Object.values(this.nodeStore.nodes()).find((candidate) =>
          samePath(candidate.path, selected.path),
        );
        return node ? { ...selected, id: node.id } : undefined;
      }
    }
  }

  isToolkitActive(section: Toolkit) {
    return this.activeToolkit() === section;
  }

  toggleBottomPanel() {
    this.isBottomPanelCollapsed.update((v) => !v);
  }

  openSearchDialog() {
    this.dialogService.open(Search);
  }
  openSettingDialog() {
    this.dialogService.open(Settings, { width: 'min(92vw, 980px)' });
  }
}

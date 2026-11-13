import { inject, Injectable, signal } from '@angular/core';
import { Search } from '../../feature/search/search';
import { DialogService } from './dialog/dialog.service';
import { GitBranchComponent } from '../../feature/git/features/branch/branch';

export type RailSection = 'Work' | 'Files' | 'Notes' | 'Review';
export type Toolkit = 'Terminal' | 'Git' | 'Log' | 'Problems';

@Injectable({
  providedIn: 'root',
})
export class LayoutService {
  readonly activeRail = signal<RailSection | null>('Work');
  readonly activeToolkit = signal<Toolkit>('Problems');
  readonly dialogService = inject(DialogService);

  readonly isBottomPanelCollapsed = signal(false);
  readonly isGitChangeDisplayed = signal(false);

  toggleRailSection(section: RailSection) {
    this.activeRail.update((v) => (v === section ? null : section));
  }

  toggleGitChange() {
    this.isGitChangeDisplayed.update((v) => !v);
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
  isToolkitActive(section: Toolkit) {
    return this.activeToolkit() === section;
  }

  toggleBottomPanel() {
    this.isBottomPanelCollapsed.update((v) => !v);
  }

  openSearchDialog() {
    this.dialogService.open(Search);
  }
  openSettingDialog() {}
}

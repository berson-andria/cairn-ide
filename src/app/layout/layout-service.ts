import { Injectable, signal } from '@angular/core';

export type RailSection = 'Work' | 'Files' | 'Notes' | 'Review';
export type Toolkit = 'Terminal' | 'Git' | 'Log' | 'Problems';

@Injectable({
  providedIn: 'root',
})
export class LayoutService {
  readonly activeRail = signal<RailSection | null>('Work');
  readonly activeToolkit = signal<Toolkit>('Problems');

  readonly isBottomPanelCollapsed = signal(false);

  toggleRailSection(section: RailSection) {
    this.activeRail.update((v) => (v === section ? null : section));
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
}

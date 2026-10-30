import { Injectable, signal } from '@angular/core';
export type RailSection = 'Work' | 'Files' | 'Notes' | 'Review';
@Injectable({
  providedIn: 'root',
})
export class LayoutService {
  readonly activeRail = signal<RailSection | null>('Work');

  toggleRailSection(section: RailSection) {
    this.activeRail.update((v) => (v === section ? null : section));
  }
  isRailSectionActive(section: RailSection) {
    return this.activeRail() === section;
  }
}

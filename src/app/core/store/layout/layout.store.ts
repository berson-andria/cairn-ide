import { signalStore, withMethods, withState } from '@ngrx/signals';
import { WorksbenchState } from './layout.state';
import { LayoutService } from '../../services/layout.service';
import { inject } from '@angular/core';

const initialState: WorksbenchState = {
  leftSidebarVisisbility: true,
  rightSidebarVisibility: true,
  bottomPanelVisibility: false,
  leftSideBarWidth: 0,
  rightSideBarWidth: 0,
  bottomPanelWidth: 0,
  activeSidebarTab: 'Explorer',
  activeResizer: null,
};

export const LayoutStore = signalStore(
  withState(initialState),
  withMethods((store, layoutService = inject(LayoutService)) => ({
    togglePrimarySideBar() {},
  })),
);

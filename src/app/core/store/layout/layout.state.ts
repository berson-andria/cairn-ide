export interface WorksbenchState {
  leftSidebarVisisbility: boolean;
  rightSidebarVisibility: boolean;
  bottomPanelVisibility: boolean;
  leftSideBarWidth: number;
  rightSideBarWidth: number;
  bottomPanelWidth: number;
  activeSidebarTab: 'Explorer' | 'Search' | 'Git' | 'Todo';
  activeResizer: 'left' | 'right' | null;
}

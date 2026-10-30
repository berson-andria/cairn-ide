import { Component } from '@angular/core';
import { BottomPanel } from '../bottom-panel/bottom-panel';
import { EmptyWorkspace } from './empty-workspace';

@Component({
  selector: 'main-panel',
  templateUrl: './main-panel.html',
  styleUrl: './main-panel.scss',
  imports: [BottomPanel, EmptyWorkspace],
})
export class MainPanel {}

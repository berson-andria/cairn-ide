import { Component } from '@angular/core';
import { BottomPanel } from '../bottom-panel/bottom-panel';

@Component({
  selector: 'main-panel',
  templateUrl: './main-panel.html',
  styleUrl: './main-panel.scss',
  imports: [BottomPanel],
})
export class MainPanel {}

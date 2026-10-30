import { Component, inject } from '@angular/core';
import { bootstrapChevronDown, bootstrapChevronRight } from '@ng-icons/bootstrap-icons';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { RailService } from './rail.service';

@Component({
  selector: 'app-rail',
  templateUrl: './rail.html',
  styleUrl: './rail.scss',
  imports: [NgIcon],
  providers: [provideIcons({ bootstrapChevronDown, bootstrapChevronRight })],
})
export class Rail {
  railService = inject(RailService);
}

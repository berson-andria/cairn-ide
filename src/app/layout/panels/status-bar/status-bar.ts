import { Component, inject } from '@angular/core';
import { MonitoringService } from '../../../core/services/monitoring.service';

@Component({
  selector: 'status-bar',
  imports: [],
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.scss',
})
export class StatusBar {
  monitoringService = inject(MonitoringService);
}

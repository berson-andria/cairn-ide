import { Component, inject } from '@angular/core';
import { WorkflowService } from '../../../core/services/runs/workflow.service';

@Component({
  selector: 'trust-setting',
  templateUrl: './trust.html',
  styleUrl: './trust.scss',
})
export class TrustSetting {
  protected readonly workflow = inject(WorkflowService);
}

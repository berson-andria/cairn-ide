import { Component, inject } from '@angular/core';
import { WorkflowService } from '../../../core/services/runs/workflow.service';
import { formatBytes } from '../../utils/utils';
import { FileIcon } from '../file-icon';
import { DialogRef } from '@angular/cdk/dialog';

@Component({
  selector: 'trust-setting',
  templateUrl: './trust.html',
  styleUrl: './trust.scss',
  imports: [FileIcon],
})
export class TrustSetting {
  protected readonly workflow = inject(WorkflowService);
  private readonly ref = inject<DialogRef>(DialogRef);
  formatBytes = formatBytes;

  cancel() {
    this.ref.close();
  }
}

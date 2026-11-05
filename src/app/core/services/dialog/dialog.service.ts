import { Injectable, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { ComponentType } from '@angular/cdk/overlay';
import { DialogWrapper } from './dialog';
import { DialogConfig } from '@angular/cdk/dialog';

@Injectable({
  providedIn: 'root',
})
export class DialogService {
  private cdkDialog = inject(Dialog);

  open<R = any, D = any>(component: ComponentType<any>, config: CustomDialogConfig<D> = {}) {
    return this.cdkDialog.open<R>(DialogWrapper, {
      width: config.width ?? '40vw',
      maxHeight: config.maxHeight ?? '80vh',
      disableClose: config.disableClose ?? false,
      role: config.role || 'dialog',
      data: {
        title: config.title,
        childComponent: component,
        childData: config.data,
      },
    });
  }
}

export interface CustomDialogConfig<D = any> extends DialogConfig<D> {
  title?: string;
}

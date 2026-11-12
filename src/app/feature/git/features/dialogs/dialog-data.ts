import { inject } from '@angular/core';
import { DIALOG_DATA } from '@angular/cdk/dialog';

/**
 * Data given to a dialog opened through DialogService.
 * DialogService wraps the child's data as { title, childComponent, childData }, so depending on how
 * DialogWrapper builds the child's injector the token holds either that wrapper or the data itself.
 * Same unwrapping GitIdentityDialog does, written once.
 *
 * Call it in a field initializer or constructor (it uses inject()).
 */
export function injectDialogData<T>(): T {
  const raw = inject(DIALOG_DATA, { optional: true }) as any;
  return (raw && typeof raw === 'object' && 'childData' in raw ? raw.childData : raw) as T;
}

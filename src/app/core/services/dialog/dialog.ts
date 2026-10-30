// dialog-wrapper.component.ts
import { Component, Inject, ViewChild, ViewContainerRef, OnInit } from '@angular/core';
import { DialogRef, DIALOG_DATA } from '@angular/cdk/dialog';
import { ComponentType } from '@angular/cdk/overlay';

@Component({
  selector: 'app-dialog-wrapper',
  standalone: true,
  template: `
    <div class="custom-dialog-container">
      <main class="custom-dialog-body">
        <ng-container #contentContainer></ng-container>
      </main>
    </div>
  `,
  styles: [
    `
      .custom-dialog-container {
        background: var(--explorer-bg) !important;
        border-radius: 0.5em;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        min-height: 20vh;
        // max-height: 100%;
        color: var(--base-text) !important;
        border: 1px solid #3e4451;
      }
      .custom-dialog-body {
        overflow-y: hidden;
      }
    `,
  ],
})
export class DialogWrapper implements OnInit {
  @ViewChild('contentContainer', { read: ViewContainerRef, static: true })
  contentContainer!: ViewContainerRef;

  constructor(
    private dialogRef: DialogRef<any>,
    @Inject(DIALOG_DATA)
    public data: { title?: string; childComponent: ComponentType<any>; childData: any },
  ) {}

  ngOnInit() {
    // Instantly spawn the requested child component into our structural body container
    const componentRef = this.contentContainer.createComponent(this.data.childComponent);

    // Pass the dedicated feature payload straight down to the child instance
    if (this.data.childData) {
      Object.assign(componentRef.instance, this.data.childData);

      // OPTIONAL: If your child relies on DIALOG_DATA token injectability instead of public properties,
      // you could create a custom injector here instead of using Object.assign.
    }
  }

  close() {
    this.dialogRef.close();
  }
}

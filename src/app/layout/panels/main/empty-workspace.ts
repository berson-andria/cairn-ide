import { Component } from '@angular/core';

@Component({
  selector: 'empty-workspace',
  template: `
    <div style="flex:1;display:flex;min-height:0">
      <div style="flex:1;display:flex;justify-content:center;padding-top:200px">
        <div>
          <div style="font-size:24px;font-weight:600">Nothing open</div>
          <div class="s" style="font-size:14px;margin:8px 0 18px">
            Pick a file, or start capturing work.
          </div>
          <div class="action-list"><span>Go to file</span><span class="chip">Ctrl P</span></div>
          <div class="action-list"><span>New task</span><span class="chip">Ctrl+Alt+T</span></div>
          <div class="action-list"><span>New note</span><span class="chip">Ctrl+Alt+N</span></div>
          <div class="action-list"><span>Toggle panel</span><span class="chip">Ctrl J</span></div>
        </div>
      </div>
    </div>
  `,
  styles: `
    :host {
      height: 100%;
      width: 100%;
    }
    .s {
      color: #a39b8b;
      font-size: 12px;
    }

    .c {
      border: 1px solid #4a443a;
      border-radius: 4px;
      padding: 1px 6px;
      font-size: 11px;
      color: #c9c1b0;
    }
  `,
})
export class EmptyWorkspace {}

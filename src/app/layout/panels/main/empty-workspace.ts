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
          <div class="h"><span>Go to file</span><span class="c">Ctrl P</span></div>
          <div class="h"><span>New task</span><span class="c">Ctrl+Alt+T</span></div>
          <div class="h"><span>New note</span><span class="c">Ctrl+Alt+N</span></div>
          <div class="h"><span>Toggle panel</span><span class="c">Ctrl J</span></div>
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
    .h {
      display: flex;
      justify-content: space-between;
      width: 400px;
      padding: 10px 0;
      border-bottom: 1px solid #2e2a24;
      font-size: 13px;
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

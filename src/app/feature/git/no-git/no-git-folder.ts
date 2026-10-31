import { Component } from '@angular/core';

@Component({
  selector: 'git-no-folder',
  template: `
    <div class="m">
      <div style="font-size:15px;font-weight:600">No folder open</div>
      <div class="s" style="margin-top:8px">Open a folder to see its changes.</div>
    </div>
  `,
  styles: `
    .m {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 0 40px;
    }
    .s {
      color: #a39b8b;
      font-size: 12px;
      line-height: 1.55;
    }
  `,
})
export class NoOpenFolder {}

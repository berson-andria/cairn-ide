import { Component } from '@angular/core';

@Component({
  selector: 'no-folder',
  template: `
    <div style="flex:1;display:flex;min-height:0">
      <div style="flex:1;display:flex;justify-content:center;padding-top:150px">
        <div style="width:520px">
          <div style="font-size:32px;font-weight:600;line-height:1.2">Open a folder to begin</div>
          <div class="s" style="font-size:14px;margin:12px 0 24px;line-height:1.55">
            Cairn keeps tasks and notes as plain files in a .ide folder inside your project, so they
            travel with your git history.
          </div>
          <div style="display:flex;gap:10px">
            <button class="b">Open Folder</button><button class="b">Open File</button
            ><button class="b">New Window</button>
          </div>
          <div class="s" style="letter-spacing:.08em;text-transform:uppercase;margin:34px 0 4px">
            Recent
          </div>
          <div class="r"><span>auth-client</span><span class="s">~/dev/auth-client</span></div>
          <div class="r"><span>cairn-ide</span><span class="s">~/dev/cairn-ide</span></div>
          <div class="r">
            <span>portfolio-site</span><span class="s">~/dev/portfolio-site</span>
          </div>
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
    .b {
      background: none;
      border: 1px solid #4a443a;
      border-radius: 6px;
      color: #e8e2d6;
      font: inherit;
      font-size: 13px;
      padding: 8px 16px;
      cursor: pointer;
    }
    .r {
      display: flex;
      justify-content: space-between;
      padding: 9px 0;
      border-bottom: 1px solid #2e2a24;
      font-size: 14px;
    }
  `,
})
export class NoFolderOpen {}

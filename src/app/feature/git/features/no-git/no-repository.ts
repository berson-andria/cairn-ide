import { Component } from '@angular/core';

@Component({
  selector: 'git-no-repository',
  template: `
    <div class="m">
      <div style="font-size:15px;font-weight:600">This folder isn't a Git repository</div>
      <div class="s" style="margin-top:8px;max-width:460px">
        Cairn uses Git to show you what a task changed before you approve it, and to keep your own
        history. Tasks and notes still work without it.
      </div>
      <div style="display:flex;gap:10px">
        <button class="p">Initialize repository</button
        ><button class="q">Choose another folder</button>
      </div>
      <div class="s" style="margin-top:10px;font-size:11px">
        Running a task stays disabled until a repository exists.
      </div>
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
    .q {
      font: inherit;
      font-size: 13px;
      padding: 8px 18px;
      border-radius: 6px;
      background: none;
      color: #e8e2d6;
      border: 1px solid #4a443a;
      margin-top: 16px;
      cursor: pointer;
    }
    .p {
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 8px 18px;
      border-radius: 6px;
      background: #e8e2d6;
      color: #1c1a17;
      border: 0;
      margin-top: 16px;
      cursor: pointer;
    }
  `,
})
export class NoRepository {}

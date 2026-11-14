import { Component } from '@angular/core';

@Component({
  selector: 'empty-task-list',
  template: `
    <div style="flex:1;overflow:hidden; margin: auto 0;">
      <div style="padding:44px 18px;text-align:center">
        <svg width="56" height="54" viewBox="0 0 56 54" fill="none" aria-hidden="true">
          <rect x="8" y="36" width="40" height="14" rx="7" fill="#3A352D"></rect>
          <rect x="14" y="20" width="28" height="13" rx="6.5" fill="#4A443A"></rect>
          <rect x="21" y="6" width="15" height="11" rx="5.5" fill="#C9C1B0"></rect>
        </svg>
        <div style="font-size:14px;font-weight:500;margin-top:14px">No tasks yet</div>
        <div style="color:#A39B8B;font-size:12px;margin:8px 0 18px;line-height:1.55">
          Tasks are small pieces of work you can hand to the model, then review.
        </div>
        <button
          style="font:inherit;font-size:13px;padding:8px 16px;border-radius:6px;cursor:pointer;width:100%;background:#E8E2D6;color:#1C1A17;border:0;font-weight:600"
        >
          New task</button
        ><button
          style="font:inherit;font-size:13px;padding:8px 16px;border-radius:6px;cursor:pointer;width:100%;background:none;color:#E8E2D6;border:1px solid #4A443A;margin-top:8px"
        >
          Plan in Chat
        </button>
        <div style="color:#A39B8B;font-size:11px;margin-top:14px">Saved as files in .ide/tasks</div>
      </div>
    </div>
  `,
  styles: `
    :host {
      flex: 1;
    }
  `,
})
export class EmptyTaskList {}

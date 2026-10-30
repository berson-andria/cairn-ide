import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MainPanel } from '../panels/main/main';
import { LeftPanel } from '../panels/left-panel/left-panel';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [LeftPanel, MainPanel],
  templateUrl: './app-shell.html',
  styleUrl: './app-shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppShell {
  // Placeholder data until the real sources exist.
  protected readonly project = 'auth-client';
  protected readonly nextReview = 'Retry once on network failure';
  protected readonly gitChanged = 4;
  protected readonly problems = 3;
  protected readonly model = 'qwen-local';

  // Window controls. The Tauri window has decorations: false, so these are ours.
  // Dynamic import keeps `ng serve` in a plain browser working: outside Tauri
  // the call fails quietly instead of breaking the app.
  protected minimize(): void {
    void this.withWindow((w) => w.minimize());
  }
  protected toggleMaximize(): void {
    void this.withWindow((w) => w.toggleMaximize());
  }
  protected close(): void {
    void this.withWindow((w) => w.close());
  }

  private async withWindow(
    action: (w: import('@tauri-apps/api/window').Window) => Promise<unknown>,
  ): Promise<void> {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await action(getCurrentWindow());
    } catch {
      /* not running inside Tauri */
    }
  }
}

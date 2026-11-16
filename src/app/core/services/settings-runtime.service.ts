import { effect, inject, Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { SettingsService } from '../../feature/setting/settings.service';

type ThemeChoice = 'dark' | 'light' | 'system';

@Injectable({ providedIn: 'root' })
export class SettingsRuntimeService {
  private readonly settings = inject(SettingsService);
  private readonly theme = this.settings.get<ThemeChoice>('appearance.theme');
  private readonly density = this.settings.get<'compact' | 'comfortable'>('appearance.layoutDensity');
  private readonly logLevel = this.settings.get<'trace' | 'debug' | 'info' | 'warn' | 'error'>(
    'diagnostics.logLevel',
  );

  constructor() {
    effect((onCleanup) => {
      const theme = this.theme();
      const density = this.density();
      const logLevel = this.logLevel();
      const root = document.documentElement;
      const media = window.matchMedia('(prefers-color-scheme: light)');
      const applyTheme = () => {
        root.dataset['theme'] = theme === 'system' ? (media.matches ? 'light' : 'dark') : theme;
      };
      applyTheme();
      if (theme === 'system') {
        media.addEventListener('change', applyTheme);
        onCleanup(() => media.removeEventListener('change', applyTheme));
      }

      // root.style.setProperty('--font-sans', font.trim() || "'Instrument Sans', system-ui, sans-serif");
      setDensity(root, density);
      void invoke('set_log_level', { level: logLevel }).catch((error) => {
        console.warn('Could not update the application log level:', error);
      });
    });
  }
}

function setDensity(root: HTMLElement, density: 'compact' | 'comfortable'): void {
  root.classList.toggle('md-ui', density === 'comfortable');
}

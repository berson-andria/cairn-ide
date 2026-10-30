import {
  ApplicationConfig,
  provideEnvironmentInitializer,
  inject,
  provideBrowserGlobalErrorListeners,
  provideAppInitializer,
} from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { TauriBootService } from './core/services/tauri/tauri-boot.service';
import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import { registerAppCommands } from './core/services/command/app-commands';
import { KeybindingService } from './core/services/command/keybinding.service';
import { provideGitBlame } from './features/git/blame/git-blame.provider';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideGitBlame(),
    provideRouter(routes),
    provideAppInitializer((keybinding = inject(KeybindingService)) => {
      registerAppCommands();
      keybinding.init();
    }),
    provideEnvironmentInitializer(async () => {
      const bootService = inject(TauriBootService);
      bootService.initApplication();
    }),
    { provide: OVERLAY_DEFAULT_CONFIG, useValue: { usePopover: false } },
  ],
};

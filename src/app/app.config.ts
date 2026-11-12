import {
  ApplicationConfig,
  provideEnvironmentInitializer,
  inject,
  provideBrowserGlobalErrorListeners,
  provideAppInitializer,
} from '@angular/core';

import { TauriBootService } from './core/services/tauri/tauri-boot.service';
import { OVERLAY_DEFAULT_CONFIG } from '@angular/cdk/overlay';
import { registerAppCommands } from './core/services/command/app-commands';
import { KeybindingService } from './core/services/command/keybinding.service';
import { provideGitBlame } from './feature/git/features/blame/git-blame.provider';
import { GitAskpassService } from './feature/git/services/git-askpass.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideGitBlame(),
    provideAppInitializer(
      (keybinding = inject(KeybindingService), gitAskpassService = inject(GitAskpassService)) => {
        registerAppCommands();
        keybinding.init();
        gitAskpassService.init();
      },
    ),
    provideEnvironmentInitializer(async () => {
      const bootService = inject(TauriBootService);
      bootService.initApplication();
    }),
    { provide: OVERLAY_DEFAULT_CONFIG, useValue: { usePopover: false } },
  ],
};

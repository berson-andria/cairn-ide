import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppShell } from './app/layout/app-shell/app-shell';

bootstrapApplication(AppShell, appConfig).catch((err: any) => console.error(err));

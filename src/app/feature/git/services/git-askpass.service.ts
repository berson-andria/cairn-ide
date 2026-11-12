import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { GitDialogService } from './git-dialog.service';
import { confirmAction } from '../ui/git-dialogs';

interface AskpassRequest {
  id: number;
  /** The question exactly as git or ssh worded it, e.g. "Enter passphrase for key '/home/me/.ssh/id_ed25519': ". */
  prompt: string;
  /** ssh's yes/no confirmation (SSH_ASKPASS_PROMPT=confirm). */
  confirm: boolean;
}

/**
 * Answers the questions git and ssh ask while a command runs: HTTPS username / password or token,
 * SSH key passphrase, "do you trust this host?". Rust sends an "askpass-request" event (askpass.rs);
 * the answer goes back through the askpass_answer command. Cancelling answers null, and git fails
 * the way it does when a person presses Ctrl+C.
 *
 * Start it once: provideAppInitializer(() => inject(GitAskpassService).init()).
 * Tauri v2 also needs "core:event:default" in the window's capabilities.
 */
@Injectable({ providedIn: 'root' })
export class GitAskpassService {
  private readonly dialogs = inject(GitDialogService);
  /** One dialog at a time: ssh may ask a username and then a password back to back. */
  private queue: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    await listen<AskpassRequest>('askpass-request', (event) => {
      this.queue = this.queue.then(() => this.handle(event.payload)).catch(() => undefined);
    });
  }

  private async handle({ id, prompt, confirm }: AskpassRequest): Promise<void> {
    let answer: string | null = null;
    try {
      answer = await this.ask(prompt.trim(), confirm);
    } finally {
      await invoke('askpass_answer', { id, answer });
    }
  }

  private async ask(prompt: string, confirm: boolean): Promise<string | null> {
    // "Are you sure you want to continue connecting (yes/no/[fingerprint])?" and similar.
    if (confirm || /\(yes\/no/i.test(prompt)) {
      const yes = await confirmAction(prompt, 'Continue');
      if (confirm) return yes ? '' : null; // confirm mode: the exit code is the answer
      return yes ? 'yes' : 'no';
    }

    const secret = /password|passphrase|token|\bpin\b/i.test(prompt);
    const label = /passphrase/i.test(prompt)
      ? 'Passphrase'
      : /password/i.test(prompt)
        ? 'Password or token'
        : /username/i.test(prompt)
          ? 'Username'
          : 'Answer';

    const result = await this.dialogs.form('Git needs your input', {
      message: prompt.replace(/:\s*$/, ''),
      fields: [{ key: 'value', label, secret }],
      submitLabel: 'OK',
    });
    return result ? result['value'] : null;
  }
}

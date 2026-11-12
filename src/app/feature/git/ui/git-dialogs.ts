import { ask } from '@tauri-apps/plugin-dialog';

/**
 * Native OK / Cancel question. Resolves to true when the user confirms.
 * (Named confirmAction so it doesn't shadow window.confirm.)
 */
export function confirmAction(message: string, okLabel: string): Promise<boolean> {
  return ask(message, {
    title: 'Cairn IDE',
    kind: 'warning',
    okLabel,
    cancelLabel: 'Cancel',
  });
}

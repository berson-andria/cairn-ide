/**
 * Styles shared by every Git dialog.
 * Only tokens from token.scss are used. Buttons use the global
 * `.btn-primary` / `.btn-action` classes, inputs sit in the global `.input-form`.
 * No background, border or radius on the host: the dialog shell owns those.
 */
export const DIALOG_STYLES = `
  :host {
    display: block;
    width: 420px;
    padding: var(--space-16);
    color: var(--color-text-primary);
    font-family: var(--font-sans);
    font-size: var(--font-size-ui);
  }

  h2 {
    margin: 0 0 var(--space-14);
    font-size: var(--font-size-prose);
    font-weight: var(--font-weight-semibold);
  }

  p {
    margin: 0 0 var(--space-12);
    font-size: var(--font-size-ui);
    line-height: var(--line-height-ui);
    color: var(--color-text-secondary);
  }

  .field {
    margin-bottom: var(--space-12);
  }
  .field label {
    display: block;
    margin-bottom: var(--space-6);
    font-size: var(--font-size-small);
    color: var(--color-text-secondary);
  }

  .input-form input {
    padding: var(--space-6) 0;
  }
  .input-form.invalid {
    border-color: var(--color-error-fg);
  }

  .error {
    margin-top: var(--space-6);
    font-size: var(--font-size-small);
    color: var(--color-error-fg);
  }

  .check {
    display: flex;
    align-items: center;
    gap: var(--space-8);
    padding: var(--space-4) 0;
    color: var(--color-text-primary);
    accent-color: var(--color-action);
  }
  .check--danger {
    color: var(--color-error-fg);
  }

  .hint {
    font-size: var(--font-size-label);
    color: var(--color-text-muted);
  }

  .sr-only {
    position: absolute;
    left: -9999px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-8);
    margin-top: var(--space-16);
  }
  .actions button {
    padding: var(--space-6) var(--space-14);
  }
  .actions button:disabled {
    opacity: 0.4;
  }
  /* Destructive primary action: same shape as .btn-action, error colour. */
  .actions .btn-danger {
    background: var(--color-error-fg);
  }
  .actions .btn-danger:hover:not(:disabled) {
    background: var(--color-error-fg);
    filter: brightness(1.08);
  }
`;

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

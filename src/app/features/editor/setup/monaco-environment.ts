/**
 * Tells Monaco how to start its web workers.
 *
 * Angular's application builder only bundles a worker when it sees the literal
 * `new Worker(new URL('<relative path>', import.meta.url))` pattern, so each
 * case below spells it out instead of using a helper function.
 */
export function setupMonacoEnvironment(): void {
  (self as any).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json':
          return new Worker(new URL('./workers/json.worker', import.meta.url), { type: 'module' });
        case 'css':
        case 'scss':
        case 'less':
          return new Worker(new URL('./workers/css.worker', import.meta.url), { type: 'module' });
        case 'html':
        case 'handlebars':
        case 'razor':
          return new Worker(new URL('./workers/html.worker', import.meta.url), { type: 'module' });
        case 'typescript':
        case 'javascript':
          return new Worker(new URL('./workers/ts.worker', import.meta.url), { type: 'module' });
        default:
          return new Worker(new URL('./workers/editor.worker', import.meta.url), {
            type: 'module',
          });
      }
    },
  };
}

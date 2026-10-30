import { Subject } from 'rxjs';

/**
 * Fires for every file-system event the workspace watcher reports, including ones for paths the
 * explorer never loaded (such as .git/index). The git service listens to refresh its status.
 */
export const fsEvents$ = new Subject<void>();

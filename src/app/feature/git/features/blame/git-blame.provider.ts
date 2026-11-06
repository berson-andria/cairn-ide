import { inject, Injector, Provider } from '@angular/core';
import { GitBlameService } from '../../services/git-blame.service';
import { BlameController } from './blame.controller';
import { EDITOR_EXTENSIONS, EditorExtensionFactory } from '../../../editor/editor-extensions';

/**
 * Adds git blame to every code editor. Put it in the app providers (app.config.ts):
 * the editor, the editor components and EditorService know nothing about blame.
 */
export function provideGitBlame(): Provider {
  return {
    provide: EDITOR_EXTENSIONS,
    multi: true,
    useFactory: (): EditorExtensionFactory => {
      const service = inject(GitBlameService);
      const injector = inject(Injector);
      return (monaco, editor) => new BlameController(monaco, editor, service, injector);
    },
  };
}

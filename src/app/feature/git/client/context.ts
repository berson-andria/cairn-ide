import { NoticeManager } from '../../../core/services/notification/notification.service';
import { GitDialogService } from '../services/git-dialog.service';
import { GitService } from '../services/git.service';

/**
 * Everything a pipeline function needs, passed explicitly instead of injected.
 * Pipelines are plain functions, not @Injectable: they can't form a DI cycle, can't be
 * injected into a component by mistake, and are trivial to unit test (pass a fake context,
 * no TestBed). GitClient is the only place that calls inject().
 *
 * `notices` is whatever notice/toast service the rest of the app already uses — the SAME
 * instance the branch/stash handlers elsewhere report through. Do not create a second one.
 */
export interface GitPipelineContext {
  git: GitService;
  dialogs: GitDialogService;
  notices: NoticeManager; // ← replace with your actual existing notice service's type
  dirtyFileCount(): number; // e.g. () => tabStore.dirtyIds().length
  saveAllOpenFiles(): Promise<boolean>; // e.g. () => editorCommands.saveAll()
}

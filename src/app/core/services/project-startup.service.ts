import { Injectable, inject } from '@angular/core';
import { EditorCommands } from '../../feature/editor/editor.commands';
import { selectStartupFolder } from '../../shared/models/project-startup.model';
import { FileSystemService } from './file-system/file-system.service';
import { NoticeManager } from './notification/notification.service';
import { ProjectHistoryService } from './project-history.service';
import { WorkspaceStateService } from './workspace-state.service';
import { handleApiError } from './tauri/api-error';
import { WorkApiService } from './tauri/work-api.service';
import { NodeStore } from '../store/node.store';

@Injectable({ providedIn: 'root' })
export class ProjectStartupService {
  private readonly api = inject(WorkApiService);
  private readonly fileSystem = inject(FileSystemService);
  private readonly history = inject(ProjectHistoryService);
  private readonly nodes = inject(NodeStore);
  private readonly editor = inject(EditorCommands);
  private readonly workspaceState = inject(WorkspaceStateService);
  private readonly notices = inject(NoticeManager);

  async initialize(): Promise<void> {
    try {
      const [args, snapshot] = await Promise.all([
        this.api.launchArgs(),
        this.api.projectHistory(),
      ]);
      this.history.history.set(snapshot);

      const launchFolderExists = args.folder
        ? await this.fileSystem.pathExists(args.folder)
        : false;
      const lastProjectExists = snapshot.lastProject
        ? await this.fileSystem.pathExists(snapshot.lastProject)
        : false;
      const folder = selectStartupFolder(
        args,
        snapshot.lastProject,
        launchFolderExists,
        lastProjectExists,
      );
      if (!folder) return;

      await this.nodes.loadFolder(folder, { silentFailure: true });
      const rootPath = this.nodes.rootPath();
      if (rootPath) {
        await this.workspaceState.restoreProject(rootPath, (id) => this.editor.openFile(id));
      }
    } catch (error) {
      await handleApiError(error, this.notices);
    }
  }
}

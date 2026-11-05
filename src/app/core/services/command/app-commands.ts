import { inject } from '@angular/core';
// Adjust to wherever your store lives.
import { CommandService } from './command.service';
import { WorkspaceNodeStore } from '../../store/workspace/workspace.store';
import { LayoutService } from '../layout.service';
import { message } from '@tauri-apps/plugin-dialog';
import { EditorCommands } from '../../../feature/editor/editor.commands';
import { GitBlameService } from '../../../feature/git/services/git-blame.service';
import { TabStore } from '../../store/tab.store';

/**
 * Connects command ids to what the app actually does.
 * Must be called from an injection context (e.g. the AppComponent constructor).
 */
export function registerAppCommands(): void {
  const commands = inject(CommandService);
  const editorCommand = inject(EditorCommands);
  const tabStore = inject(TabStore);
  const store = inject(WorkspaceNodeStore);
  const layout = inject(LayoutService);

  // ── files ──
  commands.register('file.save', async () => {
    const id = tabStore.activeTabId();
    if (!id || !tabStore.isDirty(id)) return;
    if (tabStore.isDiffTab(id)) {
      const modified = tabStore.diffTabs()[id].request.modified;
      if (modified.kind === 'worktree') {
        return await editorCommand.saveFile(modified.fileId);
      }
      return;
    } else {
      return await editorCommand.saveFile(id);
    }
  });
  commands.register('file.saveAll', () => editorCommand.saveAll());
  commands.register('file.openFile', async () => {
    const files = await store.addStandaloneFiles();
    for (const id of files) {
      editorCommand.openFile(id);
    }
  });
  commands.register('file.openFolder', () => editorCommand.openFolder());

  // ── tabs ──
  commands.register('tab.close', async () => {
    const id = tabStore.activeTabId();
    if (!id) return;
    await editorCommand.closeTab(id);
  });
  commands.register('tab.next', () => cycleTab(tabStore, +1));
  commands.register('tab.previous', () => cycleTab(tabStore, -1));

  commands.register('view.toggleLeftSidebar', () => layout.togglePrimarySideBar());
  commands.register('view.toggleRightSideBar', () => layout.toggleSecondarySideBar());

  //   commands.register('search.global',      () => layout.showSearchPanel('content'));
  //   commands.register('search.file',        () => layout.showSearchPanel('files'));
  commands.register('search.global', () => layout.openGlobalSearch());
  commands.register('search.file', () => layout.openSearchDialog());

  commands.register('explorer.selectAll', () => store.selectAllSiblings());
  commands.register('explorer.copy', () => store.copySelection());
  commands.register('explorer.cut', () => store.cutSelection());
  commands.register('explorer.delete', () => store.deleteNodes());
  commands.register('explorer.rename', () => store.startRename());
  commands.register('explorer.paste', async () => {
    const errors = await store.paste();
    if (errors.length) await message(errors.join('\n'), { title: 'Paste', kind: 'error' });
  });
  const blame = inject(GitBlameService);
  commands.register('git.toggleBlame', () => blame.toggle());
}

function cycleTab(store: InstanceType<typeof TabStore>, direction: 1 | -1): void {
  const tabs = store.openTabs();
  if (tabs.length < 2) return;
  const current = tabs.indexOf(store.activeTabId() ?? '');
  store.activate(tabs[(current + direction + tabs.length) % tabs.length]);
}

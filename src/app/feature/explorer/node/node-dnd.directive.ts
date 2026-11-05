import {
  DestroyRef,
  Directive,
  ElementRef,
  booleanAttribute,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { message } from '@tauri-apps/plugin-dialog';
import { NodeStore } from '../../../core/store/node.store';
import { topLevelIds } from '../../../shared/utils/node.utils';

/** Custom type on purpose: with 'text/plain' the editor would accept the drop and paste the ids as text. */
const MIME = 'application/x-cairn-nodes';

/** How long a drag must hover over a collapsed folder before it opens. */
const EXPAND_DELAY_MS = 700;

type Store = InstanceType<typeof NodeStore>;

/**
 * Put on a node row:  [nodeDnd]="nodeId()"   (add `nodeDndFolder` on folder rows)
 *  - the row can be dragged (the whole selection moves if the row is part of it)
 *  - dropping on a folder moves into it; dropping on a file moves into the file's folder
 * The tree's empty area handles "move to the project root" through the static helpers below.
 */
@Directive({
  selector: '[nodeDnd]',
  standalone: true,
  host: {
    // Off while the row shows its rename input, otherwise selecting text in it would start a drag.
    '[attr.draggable]': '!isRenaming()',
    '[class.is-drop-target]': 'dropActive()',
    '(dragstart)': 'onDragStart($event)',
    '(dragend)': 'onDragEnd()',
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'onDragLeave($event)',
    '(drop)': 'onDrop($event)',
  },
})
export class NodeDndDirective {
  /** Ids being dragged. The browser hides dataTransfer contents during dragover, so targets read this. */
  static dragged: string[] = [];

  private readonly store = inject(NodeStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private expandTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancelExpand());
  }

  readonly nodeId = input.required<string>({ alias: 'nodeDnd' });
  readonly isFolder = input(false, { alias: 'nodeDndFolder', transform: booleanAttribute });

  protected readonly dropActive = signal(false);
  protected readonly isRenaming = computed(() => this.store.renamingNodeId() === this.nodeId());

  /** The folder a drop on this row lands in (null = project root). */
  private target(): string | null {
    const node = this.store.nodes()[this.nodeId()];
    return this.isFolder() ? node.id : node.parentId;
  }

  protected onDragStart(event: DragEvent): void {
    const id = this.nodeId();
    if (!this.store.selectedNodeIds().includes(id)) this.store.selectNode(id, 'single');

    NodeDndDirective.dragged = topLevelIds(this.store.nodes(), this.store.selectedNodeIds());
    event.dataTransfer?.setData(MIME, JSON.stringify(NodeDndDirective.dragged));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragEnd(): void {
    NodeDndDirective.dragged = [];
    this.dropActive.set(false);
    this.cancelExpand();
  }

  protected onDragLeave(event: DragEvent): void {
    // Moving between the row's own children (icon -> name) also fires dragleave: ignore those.
    if (event.relatedTarget && this.host.nativeElement.contains(event.relatedTarget as Node))
      return;
    this.dropActive.set(false);
    this.cancelExpand();
  }

  /** Spring-loaded folder: hovering a collapsed folder during a drag opens it after a short delay. */
  private scheduleExpand(): void {
    if (!this.isFolder() || this.expandTimer) return; // files never expand; one timer per hover
    const id = this.nodeId();
    if (this.store.explorerUiState()[id]?.isExpanded) return;
    this.expandTimer = setTimeout(() => {
      this.expandTimer = undefined;
      void this.store.expandFolder(id);
    }, EXPAND_DELAY_MS);
  }

  private cancelExpand(): void {
    clearTimeout(this.expandTimer);
    this.expandTimer = undefined;
  }

  protected onDragOver(event: DragEvent): void {
    if (!NodeDndDirective.canDrop(this.store, this.target())) return;
    event.preventDefault(); // this is what marks the row as a valid drop target
    event.stopPropagation(); // the tree's root-level handler must not also react
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dropActive.set(this.isFolder());
    this.scheduleExpand(); // dragover keeps firing while the cursor rests, so the timer completes
  }

  protected async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.dropActive.set(false);
    this.cancelExpand();
    await NodeDndDirective.drop(this.store, this.target());
  }

  // ───────────── shared with the tree's empty area ─────────────

  /** False for: nothing being dragged, dropping a folder into itself, or into one of its own descendants. */
  static canDrop(store: Store, targetFolderId: string | null): boolean {
    if (!NodeDndDirective.dragged.length) return false;
    for (let id = targetFolderId; id; id = store.nodes()[id]?.parentId ?? null) {
      if (NodeDndDirective.dragged.includes(id)) return false;
    }
    return true;
  }

  static async drop(store: Store, targetFolderId: string | null): Promise<void> {
    const ids = NodeDndDirective.dragged;
    NodeDndDirective.dragged = [];
    if (!ids.length || !NodeDndDirective.canDropIds(store, ids, targetFolderId)) return;

    const errors = await store.moveNodes(ids, targetFolderId);
    if (errors.length) await message(errors.join('\n'), { title: 'Move', kind: 'error' });
  }

  private static canDropIds(store: Store, ids: string[], target: string | null): boolean {
    for (let id = target; id; id = store.nodes()[id]?.parentId ?? null) {
      if (ids.includes(id)) return false;
    }
    return true;
  }
}

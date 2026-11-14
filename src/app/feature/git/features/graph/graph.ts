import { CdkVirtualScrollViewport, ScrollingModule } from '@angular/cdk/scrolling';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NodeStore } from '../../../../core/store/node.store';
import { CommitDetails, CommitFile, GraphCommit } from '../../parser/log.parser';
import { GitClient } from '../../services/git-client.service';
import { GitService } from '../../services/git.service';
import { NoOpenFolder } from '../no-git/no-git-folder';
import { NoRepository } from '../no-git/no-repository';
import { GraphRow, LANE_W, MAX_LANES, ROW_H, laneX, layoutGraph, timeAgo } from './graph.layout';

// Lane colors come from the hue tokens, so they change with the theme. Not the attention color:
// that one is reserved for things that need you.
const PALETTE = [
  'var(--hue-blue)',
  'var(--hue-purple)',
  'var(--hue-green)',
  'var(--hue-orange)',
  'var(--hue-pink)',
  'var(--hue-yellow)',
];

/**
 * The commit graph: toolbar (search, scope, fetch), the commit list and a details pane for the
 * selected commit. It does work only while it exists, so render it with @if when its tab is
 * not the active one.
 */
@Component({
  selector: 'git-graph',
  templateUrl: './graph.html',
  styleUrl: './graph.scss',
  imports: [ScrollingModule, NoRepository, NoOpenFolder],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { tabindex: '0', '(keydown)': 'onKey($event)' },
})
export class GitGraph {
  /** Read-only state (signals). */
  protected readonly git = inject(GitService);
  /** Every action goes through GitClient, as in the rest of the Git feature. */
  private readonly client = inject(GitClient);
  protected readonly nodeStore = inject(NodeStore);

  /** Commits per page. More are loaded when you scroll near the end. */
  readonly pageSize = input(200);
  /** The "Uncommitted changes" row was clicked: show the Git changes panel. */
  readonly openChanges = output<void>();
  /** A file in the details pane was clicked: open its diff (see GitService.readCommitDiff). */
  readonly openCommitFile = output<{ hash: string; file: CommitFile }>();

  protected readonly rowHeight = ROW_H;
  protected readonly scope = signal<'all' | 'head'>('all');
  protected readonly query = signal('');
  protected readonly selected = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly done = signal(false);
  protected readonly details = signal<CommitDetails | null>(null);

  private readonly commits = signal<GraphCommit[]>([]);
  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  private readonly layout = computed(() => layoutGraph(this.commits()));
  protected readonly graphWidth = computed(
    () => Math.min(this.layout().lanes, MAX_LANES) * LANE_W + 10,
  );
  protected readonly filtering = computed(() => this.query().trim().length > 0);

  /**
   * While searching, the list is filtered and the lines are hidden: lines only make sense when
   * every commit between two dots is present.
   */
  protected readonly rows = computed<GraphRow[]>(() => {
    const q = this.query().trim().toLowerCase();
    const all = this.layout().rows;
    if (!q) return all;
    return all.filter(({ commit: c }) =>
      [c.subject, c.author, c.hash, ...c.refs.map((r) => r.name)].some((t) =>
        t.toLowerCase().includes(q),
      ),
    );
  });

  protected readonly selectedCommit = computed(
    () => this.commits().find((c) => c.hash === this.selected()) ?? null,
  );
  protected readonly uncommitted = computed(() => this.git.status()?.files.length ?? 0);

  private lastKey = '';
  private generation = 0;

  constructor() {
    // statusVersion bumps after every status refresh, i.e. after every file change. Editing a
    // file does not change history, so first compare the refs: only a real change reloads.
    effect(() => {
      this.git.repoRoot();
      this.scope();
      this.git.statusVersion();
      untracked(() => void this.sync());
    });

    effect(() => {
      const hash = this.selected();
      untracked(() => void this.loadDetails(hash));
    });
    effect((onCleanup) => {
      const viewport = this.viewport();
      if (!viewport) return;
      const observer = new ResizeObserver(() => viewport.checkViewportSize());
      observer.observe(viewport.elementRef.nativeElement);
      onCleanup(() => observer.disconnect());
    });
  }

  // ───────────── loading ─────────────

  private async sync() {
    if (!this.git.isRepo()) {
      this.commits.set([]);
      this.lastKey = '';
      return;
    }
    const key = `${this.scope()}|${await this.git.refsSignature()}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    await this.loadPage(true);
  }

  private async loadPage(reset: boolean) {
    const generation = reset ? ++this.generation : this.generation;
    this.loading.set(true);
    const skip = reset ? 0 : this.commits().length;
    const page = await this.git.graphLog(this.scope(), this.pageSize(), skip);
    if (generation !== this.generation) return; // a newer reload started meanwhile
    this.commits.update((all) => (reset ? page : [...all, ...page]));
    this.done.set(page.length < this.pageSize());
    this.loading.set(false);
  }

  protected nearEnd() {
    const viewport = this.viewport();
    if (!viewport || this.loading() || this.done() || this.filtering()) return;
    if (viewport.getRenderedRange().end >= this.rows().length - 30) void this.loadPage(false);
  }

  private async loadDetails(hash: string | null) {
    if (!hash) return this.details.set(null);
    const details = await this.git.commitDetails(hash);
    if (this.selected() === hash) this.details.set(details);
  }

  // ───────────── actions ─────────────

  protected select(hash: string) {
    this.selected.set(hash);
  }

  protected toggleScope() {
    this.scope.update((s) => (s === 'all' ? 'head' : 'all'));
  }

  /** Notices, credentials and the busy flag are handled by the fetch pipeline. */
  protected fetch() {
    return this.client.fetch();
  }

  protected onKey(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement) return; // typing in the search box
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const rows = this.rows();
    if (!rows.length) return;
    const current = rows.findIndex((r) => r.commit.hash === this.selected());
    const next = Math.min(rows.length - 1, Math.max(0, current + step));
    this.selected.set(rows[next].commit.hash);
    const range = this.viewport()?.getRenderedRange();
    if (range && (next <= range.start || next >= range.end - 1)) {
      this.viewport()?.scrollToIndex(Math.max(0, next - 3));
    }
  }

  // ───────────── helpers for the template ─────────────

  protected readonly x = laneX;
  protected readonly ago = timeAgo;
  protected color = (lane: number) => PALETTE[lane % PALETTE.length];
  protected isHead = (row: GraphRow) => row.commit.refs.some((r) => r.current);
  protected trackRow = (_: number, row: GraphRow) => row.commit.hash;
  protected fullDate = (isoDate: string) => new Date(isoDate).toLocaleString();
}

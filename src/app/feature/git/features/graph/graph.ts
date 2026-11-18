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
import {
  GraphRow,
  LANE_W,
  MAX_LANES,
  ROW_H,
  isBranchRef,
  laneX,
  layoutGraph,
  timeAgo,
} from './graph.layout';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideX } from '@ng-icons/lucide';
import { FileIcon } from '../../../../shared/components/file-icon';
import { GitUiStatus, statusStyle } from '../../ui/git-ui';
import { LayoutService } from '../../../../core/services/layout.service';
import { GitDiffService } from '../../services/git-diff.service';
import { NoticeManager } from '../../../../core/services/notification/notification.service';

// Lane colors come from the hue tokens, so they change with the theme. Not the attention color:
// that one is reserved for things that need you.
const PALETTE = [
  'var(--hue-blue)',
  'var(--hue-pink)',
  'var(--hue-green)',
  'var(--hue-orange)',
  'var(--hue-purple)',
  'var(--hue-yellow)',
];

@Component({
  selector: 'git-graph',
  templateUrl: './graph.html',
  styleUrl: './graph.scss',
  imports: [ScrollingModule, NoRepository, NoOpenFolder, NgIcon, FileIcon],
  providers: [provideIcons({ lucideX })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { tabindex: '0', '(keydown)': 'onKey($event)' },
})
export class GitGraph {
  /** Read-only state (signals). */
  protected readonly git = inject(GitService);
  private readonly client = inject(GitClient);
  protected readonly nodeStore = inject(NodeStore);
  protected readonly layoutService = inject(LayoutService);
  protected readonly gitDiff = inject(GitDiffService);
  protected readonly notices = inject(NoticeManager);

  /** Commits per page. More are loaded when you scroll near the end. */
  readonly pageSize = input(200);

  protected readonly rowHeight = ROW_H;
  protected readonly scope = signal<'all' | 'head'>('all');
  protected readonly query = signal('');
  protected readonly selected = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly done = signal(false);
  protected readonly details = signal<CommitDetails | null>(null);

  private readonly commits = signal<GraphCommit[]>([]);

  /** Primary branch ("main" or "origin/main"), from the function GitService already has. */
  private readonly primary = signal<string | null>(null);

  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  /** ref name -> palette index, in order of first appearance. Dies with the component. */
  private readonly branchColors = new Map<string, number>();

  protected readonly statusStyle = statusStyle;

  protected fileName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  protected statusLetter(status: CommitFile['status']): GitUiStatus {
    switch (status) {
      case 'modified':
        return 'M';
      case 'added':
        return 'A';
      case 'deleted':
        return 'D';
      case 'renamed':
        return 'R';
      case 'copied':
        return 'C';
      case 'typechange':
        return 'T';
    }
  }

  private colorIndex(name: string): number {
    let i = this.branchColors.get(name);
    if (i === undefined) this.branchColors.set(name, (i = this.branchColors.size));
    return i;
  }

  private readonly layout = computed(() => {
    const result = layoutGraph(this.commits(), { primary: this.primary() });
    for (const row of result.rows) {
      for (const ref of row.commit.refs) {
        // Bare refs (a branch created here with no commits of its own) get no color.
        if (isBranchRef(ref) && !row.bare.includes(ref.name)) this.colorIndex(ref.name);
      }
    }
    // Names that are not refs (a merged and deleted branch, an unnamed tip) come after.
    for (const row of result.rows) {
      this.colorIndex(row.branch);
      for (const seg of row.segments) this.colorIndex(seg.branch);
    }
    return result;
  });

  protected readonly legend = computed(() => {
    this.layout();
    return [...this.branchColors.keys()].map((name) => ({ name, color: this.color(name) }));
  });
  protected readonly graphWidth = computed(
    () => Math.min(this.layout().lanes, MAX_LANES) * LANE_W + 10,
  );
  protected readonly filtering = computed(() => this.query().trim().length > 0);

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
    effect(async () => {
      this.git.repoRoot();
      this.scope();
      this.git.statusVersion();
      console.log(await this.git.primaryBranch());

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
    this.primary.set(await this.git.primaryBranch().catch(() => null));
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
  async openDiff(hash: string, file: CommitFile) {
    const request = this.gitDiff.requestForCommits(`${hash}^`, hash, file);
    if (request) {
      const error = await this.gitDiff.open(request);
      if (error) this.notices.report({ ok: false, error: error });
    }
  }
  // ───────────── helpers for the template ─────────────

  protected readonly x = laneX;
  protected readonly ago = timeAgo;
  protected isBranch = isBranchRef;
  protected color = (name: string) => PALETTE[this.colorIndex(name) % PALETTE.length];
  protected isHead = (row: GraphRow) => row.commit.refs.some((r) => r.current);
  protected trackRow = (_: number, row: GraphRow) => row.commit.hash;
  protected fullDate = (isoDate: string) => new Date(isoDate).toLocaleString();
}

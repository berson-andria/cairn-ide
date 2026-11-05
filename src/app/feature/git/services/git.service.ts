import { fsEvents$ } from '../../../core/services/file-system/fs-events';
import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { debounceTime } from 'rxjs';
// Adjust these paths to your folders.
import { TauriBridgeService } from '../../../core/services/tauri/tauri-bridge.service';

import { NodeStore } from '../../../core/store/node.store';
import {
  GitChangeKind,
  GitFileStatus,
  GitStatus,
  parseStatusV2,
} from '../parser/git-status.parser';
import {
  BRANCH_FORMAT,
  GitBranch,
  GitCommit,
  GitStash,
  LOG_FORMAT,
  parseBranches,
  parseLog,
  parseStashes,
  STASH_FORMAT,
  FileBlame,
  parseBlame,
  COMMIT_DETAILS_FORMAT,
  CommitDetails,
  CommitFile,
  parseCommitDetails,
} from '../parser/git-parsers';
import { normalizePath } from '../../../core/services/file-system/external-watcher.utils';

export interface GitCommandOutput {
  stdout: string;
  stderr: string;
  /** camelCase: that is what the Rust side serializes. (`exit_code` here would always be undefined.) */
  exitCode: number | null;
  success: boolean;
}

/** What every action returns. `error` is git's own message, ready to show. */
export interface GitResult {
  ok: boolean;
  output: string;
  error: string;
  /** True when git could not be run at all (not installed, refused by the allowlist, timed out). */
  unavailable?: boolean;
  /** Set when the failure has a known remedy: 'identity' = git doesn't know the user's name/email yet. */
  code?: 'identity';
}

const ok = (output = ''): GitResult => ({ ok: true, output, error: '' });
const fail = (error: string): GitResult => ({ ok: false, output: '', error });

/** What git says when user.name / user.email aren't configured (wording varies by version and platform). */
const IDENTITY_ERROR =
  /Please tell me who you are|Author identity unknown|unable to auto-detect email address/i;

/** What the explorer shows next to a file. */
export interface GitBadge {
  letter: string;
  kind: GitChangeKind;
  staged: boolean;
}

const LETTERS: Record<GitChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
  conflicted: '!',
};

const NETWORK_TIMEOUT = 300; // seconds: fetch/pull/push
const SLOW_TIMEOUT = 120; // commit hooks can take a while

/** Paths from git and from the explorer are compared in one normal form (backslashes, lower case). */
const keyOf = (path: string) => normalizePath(path).toLowerCase();

@Injectable({ providedIn: 'root' })
export class GitService {
  tauri = inject(TauriBridgeService);
  store = inject(NodeStore);
  rootPath = this.store.rootPath;

  /** Top of the repository, or null when the open folder is not inside one. */
  readonly repoRoot = signal<string | null>(null);
  readonly status = signal<GitStatus | null>(null);
  /** Set when git itself can't be used (not installed), as opposed to "this folder is not a repo". */
  readonly error = signal<string | null>(null);
  readonly isRepo = computed(() => this.repoRoot() !== null);
  /** True while a change to the repository is running (to disable buttons). */
  readonly busy = signal(false);
  /** Bumps after every successful status load. The diff editor watches it to reload the git-side text. */
  readonly statusVersion = signal(0);

  readonly staged = computed(() => this.status()?.files.filter((f) => f.staged) ?? []);
  readonly unstaged = computed(
    () => this.status()?.files.filter((f) => f.unstaged && f.kind !== 'conflicted') ?? [],
  );
  /** Files with an unresolved merge conflict. */
  readonly conflicts = computed(
    () => this.status()?.files.filter((f) => f.kind === 'conflicted') ?? [],
  );

  /** absolute path -> its status, for O(1) lookups while the explorer renders. */
  readonly byPath = computed(() => {
    const map = new Map<string, GitFileStatus>();
    const root = this.repoRoot();
    for (const file of this.status()?.files ?? []) {
      if (root) map.set(keyOf(`${root}/${file.path}`), file);
    }
    return map;
  });

  /** Every folder that has a change somewhere inside it (to mark parents in the tree). */
  readonly changedFolders = computed(() => {
    const folders = new Set<string>();
    const root = this.repoRoot();
    if (!root) return folders;
    for (const file of this.status()?.files ?? []) {
      const parts = file.path.split('/').slice(0, -1);
      let current = normalizePath(root);
      for (const part of parts) {
        current += `\\${part}`;
        folders.add(current.toLowerCase());
      }
    }
    return folders;
  });

  private running?: Promise<void>;
  private refreshAgain = false;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor() {
    // The open folder changed: look for a repository again.
    effect(() => {
      this.rootPath();
      untracked(() => void this.refresh());
    });
    // Any file-system activity (including .git/index changing after a terminal `git add`).
    fsEvents$.pipe(debounceTime(500), takeUntilDestroyed()).subscribe(() => void this.refresh());

    (window as any).__git = () => ({
      repoRoot: this.repoRoot(),
      error: this.error(),
      status: this.status(),
    });
  }

  // ───────────── running git ─────────────

  /** Raw access (your original method), for anything not covered below. Throws if git can't run. */
  runGitCommand(path: string, args: string[], timeoutSecs?: number, stdin?: string) {
    return this.tauri.invokeCommand<GitCommandOutput>('git_run', {
      cwd: path,
      args,
      timeoutSecs: timeoutSecs ?? null,
      stdin: stdin ?? null, // only accepted by the Rust side for `blame --contents -`
    });
  }

  /**
   * Runs one git command and never throws. Default working directory is the repository ROOT:
   * paths in `git status` are relative to it, so path arguments only mean the right thing there.
   */
  private async exec(
    args: string[],
    options: { cwd?: string; timeoutSecs?: number; stdin?: string } = {},
  ): Promise<GitResult> {
    const cwd = options.cwd ?? this.repoRoot() ?? this.rootPath();
    if (!cwd) return fail('No folder is open.');
    try {
      const out = await this.runGitCommand(cwd, args, options.timeoutSecs, options.stdin);
      return { ok: out.success, output: out.stdout, error: (out.stderr || out.stdout).trim() };
    } catch (err) {
      return {
        ...fail(typeof err === 'string' ? err : 'Git could not be run.'),
        unavailable: true,
      };
    }
  }

  /**
   * Anything that changes the repository goes through here: one at a time (two commands touching
   * the index at once fail with "index.lock exists"), then the status is refreshed.
   */
  private mutate(
    args: string[],
    options: { cwd?: string; timeoutSecs?: number } = {},
  ): Promise<GitResult> {
    const job = this.mutations.then(async () => {
      this.busy.set(true);
      try {
        return await this.exec(args, options);
      } finally {
        this.busy.set(false);
      }
    });
    this.mutations = job.catch(() => undefined);
    return job.then(async (result) => {
      await this.refresh();
      return result;
    });
  }

  // ───────────── status ─────────────

  /** Safe to call as often as you like: overlapping calls collapse into one follow-up run. */
  refresh(): Promise<void> {
    if (this.running) {
      this.refreshAgain = true;
      return this.running;
    }
    this.running = this.load().finally(() => {
      this.running = undefined;
      if (this.refreshAgain) {
        this.refreshAgain = false;
        void this.refresh();
      }
    });
    return this.running;
  }

  private async load(): Promise<void> {
    const workspace = this.rootPath();
    if (!workspace) return this.clear(null);

    const top = await this.exec(['rev-parse', '--show-toplevel'], { cwd: workspace });
    if (top.unavailable) return this.clear(top.error); // git missing or refused
    if (!top.ok) return this.clear(null); // a plain folder, not a repository

    const status = await this.exec(
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
      {
        cwd: workspace,
      },
    );
    if (!status.ok) return this.clear(`git status failed: ${status.error}`);

    this.repoRoot.set(normalizePath(top.output.trim()));
    this.status.set(parseStatusV2(status.output));
    this.error.set(null);
    this.statusVersion.update((v) => v + 1);
  }

  private clear(error: string | null) {
    this.repoRoot.set(null);
    this.status.set(null);
    this.error.set(error);
  }

  // ───────────── explorer helpers ─────────────

  badgeFor(absolutePath: string): GitBadge | null {
    const file = this.byPath().get(keyOf(absolutePath));
    return file
      ? { letter: LETTERS[file.kind], kind: file.kind, staged: file.staged && !file.unstaged }
      : null;
  }

  hasChangesInside(absoluteFolderPath: string): boolean {
    return this.changedFolders().has(keyOf(absoluteFolderPath));
  }

  /** "src/a.ts" (as git reports it) -> the absolute path the explorer and editor use. */
  absolutePathOf(repoRelativePath: string): string | null {
    const root = this.repoRoot();
    return root ? normalizePath(`${root}/${repoRelativePath}`) : null;
  }

  /** "C:\proj\src\a.ts" -> "src/a.ts" (what git calls it), or null if it is outside the repository. */
  repoPathOf(absolutePath: string): string | null {
    const root = this.repoRoot();
    if (!root) return null;
    const abs = normalizePath(absolutePath);
    const prefix = normalizePath(root) + '\\';
    if (!abs.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    return abs.slice(prefix.length).replace(/\\/g, '/');
  }

  // ───────────── staging ─────────────
  // `paths` are the repository-relative paths from the status (GitFileStatus.path).

  stage(paths: string[]): Promise<GitResult> {
    return paths.length ? this.mutate(['add', '--', ...paths]) : Promise.resolve(ok());
  }

  stageAll(): Promise<GitResult> {
    return this.mutate(['add', '-A']);
  }

  /** `reset`, not `restore --staged`: the latter fails in a repository that has no commits yet. */
  unstage(paths: string[]): Promise<GitResult> {
    return paths.length ? this.mutate(['reset', '-q', '--', ...paths]) : Promise.resolve(ok());
  }

  unstageAll(): Promise<GitResult> {
    return this.mutate(['reset', '-q']);
  }

  /**
   * Throws away UNSTAGED changes (the caller should confirm first; this cannot be undone):
   *  - tracked files go back to their staged/committed content,
   *  - untracked files are deleted. `git clean` only ever touches untracked files, so a tracked
   *    file can't be removed this way.
   * Staged changes are left alone: unstage them first to discard those too.
   */
  async discard(files: GitFileStatus[]): Promise<GitResult> {
    const tracked = files.filter(
      (f) => f.unstaged && f.kind !== 'untracked' && f.kind !== 'conflicted',
    );
    const untracked = files.filter((f) => f.kind === 'untracked');

    if (tracked.length) {
      const restored = await this.mutate(['restore', '--', ...tracked.map((f) => f.path)]);
      if (!restored.ok) return restored;
    }
    if (untracked.length) {
      return this.mutate(['clean', '-f', '--', ...untracked.map((f) => f.path)]);
    }
    return ok();
  }

  // ───────────── commits ─────────────

  commit(message: string, options: { all?: boolean; amend?: boolean } = {}): Promise<GitResult> {
    const text = message.trim();
    if (!text && !options.amend) return Promise.resolve(fail('Enter a commit message.'));

    const args = ['commit'];
    if (options.all) args.push('-a');
    if (options.amend) args.push('--amend');
    if (text) args.push('-m', text);
    else args.push('--no-edit');
    return this.mutate(args, { timeoutSecs: SLOW_TIMEOUT }).then((result) =>
      !result.ok && IDENTITY_ERROR.test(result.error)
        ? { ...result, code: 'identity' as const }
        : result,
    );
  }

  /** Undo the last commit but keep its changes staged. Nothing is lost. */
  undoLastCommit(): Promise<GitResult> {
    return this.mutate(['reset', '--soft', 'HEAD~1']);
  }

  /** For pre-filling the box when amending. */
  async lastCommitMessage(): Promise<string> {
    const result = await this.exec(['log', '-1', '--format=%B']);
    return result.ok ? result.output.trim() : '';
  }

  async history(limit = 50, absolutePath?: string, skip: number = 0): Promise<GitCommit[]> {
    const args = ['log', `-n${Math.max(1, Math.floor(limit))}`, LOG_FORMAT];
    if (absolutePath) {
      const relative = this.repoPathOf(absolutePath);
      if (!relative) return [];
      args.push('--follow', '--', relative);
      args.push(`--skip=${skip}`);
    }
    const result = await this.exec(args);
    return result.ok ? parseLog(result.output) : [];
  }
  /** Accepts only hex hashes, so a ref can never be read as an option. */
  private isCommitHash(hash: string): boolean {
    return /^[0-9a-f]{4,40}$/i.test(hash);
  }

  /** Message, date, hash and the files a commit changed. null if the hash is invalid or unknown. */
  async commitDetails(hash: string): Promise<CommitDetails | null> {
    if (!this.isCommitHash(hash)) return null;
    const result = await this.exec([
      'show',
      '-z',
      '--name-status',
      '-M', // detect renames
      '-m', // merge commits: diff against the first parent
      '--first-parent',
      COMMIT_DETAILS_FORMAT,
      hash,
    ]);
    console.log(result);

    return result.ok ? parseCommitDetails(result.output) : null;
  }

  /**
   * A file as it was in a commit. `repoRelativePath` is CommitFile.path (not an absolute path).
   * null if the file doesn't exist there (e.g. the left side of an added file).
   */
  async readAtCommit(hash: string, repoRelativePath: string): Promise<string | null> {
    if (!/^[0-9a-f]{4,40}\^?$/i.test(hash) || !repoRelativePath) return null;
    const result = await this.exec(['show', `${hash}:${repoRelativePath}`]);
    return result.ok ? result.output : null;
  }

  /**
   * Both sides of a commit's change to one file, ready for a diff editor.
   * Uses oldPath for renames; the parent side is null for added files and for the root commit.
   */
  async readCommitDiff(
    hash: string,
    file: CommitFile,
  ): Promise<{ before: string | null; after: string | null }> {
    const before =
      file.status === 'added'
        ? null
        : await this.readAtCommit(`${hash}^`, file.oldPath ?? file.path);
    const after = file.status === 'deleted' ? null : await this.readAtCommit(hash, file.path);
    return { before, after };
  }

  // ───────────── branches ─────────────

  async branches(): Promise<GitBranch[]> {
    const result = await this.exec(['branch', '-a', BRANCH_FORMAT]);
    return result.ok ? parseBranches(result.output) : [];
  }

  /** null = valid; otherwise git's reason. Use it while the user types a new branch name. */
  async checkBranchName(name: string): Promise<string | null> {
    if (!name.trim() || name.startsWith('-')) return 'Enter a branch name.';
    const result = await this.exec(['check-ref-format', '--branch', name]);
    return result.ok ? null : `"${name}" is not a valid branch name.`;
  }

  /** Switch to an existing LOCAL branch. For a branch from `branches()` use `switchTo`, which also handles remote ones. */
  switchBranch(name: string): Promise<GitResult> {
    if (!name || name.startsWith('-')) return Promise.resolve(fail('Invalid branch name.'));
    return this.mutate(['switch', name]);
  }

  /**
   * Switch to a branch as listed by `branches()`. A remote-only branch ("origin/feature") needs
   * `--track`: a plain `git switch origin/feature` fails with "a branch is expected, got remote branch".
   */
  switchTo(branch: GitBranch): Promise<GitResult> {
    if (branch.current) return Promise.resolve(ok());
    return branch.remote
      ? this.mutate(['switch', '--track', branch.name])
      : this.switchBranch(branch.name);
  }

  createBranch(
    name: string,
    options: { from?: string; switchTo?: boolean } = {},
  ): Promise<GitResult> {
    if (!name || name.startsWith('-')) return Promise.resolve(fail('Invalid branch name.'));
    const switchTo = options.switchTo ?? true;
    const args = switchTo ? ['switch', '-c', name] : ['branch', name];
    if (options.from) args.push(options.from);
    return this.mutate(args);
  }

  /** `force` deletes even if the branch isn't merged (its commits may become unreachable). */
  deleteBranch(name: string, force = false): Promise<GitResult> {
    if (!name || name.startsWith('-')) return Promise.resolve(fail('Invalid branch name.'));
    return this.mutate(['branch', force ? '-D' : '-d', name]);
  }

  merge(branch: string): Promise<GitResult> {
    if (!branch || branch.startsWith('-')) return Promise.resolve(fail('Invalid branch name.'));
    // On conflicts this returns ok=false; `conflicts()` then lists the files to resolve.
    return this.mutate(['merge', '--no-edit', branch]);
  }

  mergeAbort(): Promise<GitResult> {
    return this.mutate(['merge', '--abort']);
  }

  // ───────────── identity ─────────────

  /** What git would put on a commit; empty strings when not configured. */
  async getIdentity(): Promise<{ name: string; email: string }> {
    const [name, email] = await Promise.all([
      this.exec(['config', '--get', 'user.name']),
      this.exec(['config', '--get', 'user.email']),
    ]);
    return { name: name.ok ? name.output.trim() : '', email: email.ok ? email.output.trim() : '' };
  }

  /** `global` = for every repository on this machine (the usual choice); `local` = this repository only. */
  async setIdentity(
    name: string,
    email: string,
    scope: 'global' | 'local' = 'global',
  ): Promise<GitResult> {
    const n = name.trim();
    const e = email.trim();
    if (!n || !e) return fail('Both a name and an email are required.');
    if (n.startsWith('-') || e.startsWith('-')) return fail('That name or email is not valid.');
    const nameResult = await this.exec(['config', `--${scope}`, 'user.name', n]);
    if (!nameResult.ok) return nameResult;
    return this.exec(['config', `--${scope}`, 'user.email', e]);
  }

  // ───────────── remotes ─────────────

  fetch(): Promise<GitResult> {
    return this.mutate(['fetch', '--prune'], { timeoutSecs: NETWORK_TIMEOUT });
  }

  /**
   * Fast-forward only: if both sides have new commits this fails instead of silently creating a merge
   * commit. Merge or rebase yourself in that case.
   */
  pull(): Promise<GitResult> {
    return this.mutate(['pull', '--ff-only'], { timeoutSecs: NETWORK_TIMEOUT });
  }

  async push(options: { force?: boolean } = {}): Promise<GitResult> {
    const status = this.status();
    const args = ['push'];
    if (options.force) args.push('--force-with-lease'); // refuses if someone else pushed meanwhile

    // A new branch has no upstream yet and a plain `git push` refuses.
    if (status && !status.upstream) {
      if (!status.branch)
        return fail('You are not on a branch (detached HEAD), so there is nothing to push.');
      const remote = await this.defaultRemote();
      if (!remote)
        return fail(
          'This repository has no remote yet. In the terminal: git remote add origin <url>',
        );
      args.push('--set-upstream', remote, status.branch);
    }
    return this.mutate(args, { timeoutSecs: NETWORK_TIMEOUT });
  }

  async defaultRemote(): Promise<string | null> {
    const result = await this.exec(['remote']);
    const remotes = result.ok ? result.output.split(/\r?\n/).filter(Boolean) : [];
    return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
  }

  // ───────────── stash ─────────────

  /** Includes untracked files, so the working tree really ends up clean. */
  stash(message?: string): Promise<GitResult> {
    const args = ['stash', 'push', '--include-untracked'];
    if (message?.trim()) args.push('-m', message.trim());
    return this.mutate(args);
  }

  async stashes(): Promise<GitStash[]> {
    const result = await this.exec(['stash', 'list', STASH_FORMAT]);
    return result.ok ? parseStashes(result.output) : [];
  }

  /** Apply and remove. If applying conflicts, git keeps the stash so nothing is lost. */
  stashPop(index = 0): Promise<GitResult> {
    return this.mutate(['stash', 'pop', `stash@{${index}}`]);
  }

  stashApply(index = 0): Promise<GitResult> {
    return this.mutate(['stash', 'apply', `stash@{${index}}`]);
  }

  stashDrop(index = 0): Promise<GitResult> {
    return this.mutate(['stash', 'drop', `stash@{${index}}`]);
  }

  // ───────────── repositories ─────────────

  /** Turns the open folder into a repository. */
  init(): Promise<GitResult> {
    return this.mutate(['init'], { cwd: this.rootPath() ?? undefined });
  }

  /**
   * Clones into `<parentDir>/<folderName>` (the name defaults to the one in the URL).
   * On success `path` is the new folder, ready to open. This does not touch the current repository.
   */
  async clone(
    url: string,
    parentDir: string,
    folderName?: string,
  ): Promise<GitResult & { path?: string }> {
    const target = url.trim();
    if (!target || target.startsWith('-')) return fail('Enter a repository URL.');

    const name = folderName?.trim() || this.folderNameFromUrl(target);
    if (!name || name === '..' || /[\\/]/.test(name))
      return fail('Could not work out a folder name for the clone.');

    // `--` so a URL can never be read as an option.
    const result = await this.exec(['clone', '--', target, name], {
      cwd: parentDir,
      timeoutSecs: 900,
    });
    return { ...result, path: result.ok ? `${normalizePath(parentDir)}\\${name}` : undefined };
  }

  /** "https://host/a/repo.git", "git@host:a/repo.git", "https://host/a/repo/" -> "repo" */
  private folderNameFromUrl(url: string): string {
    return (
      url
        .replace(/[\\/]+$/, '')
        .split(/[\\/:]/)
        .pop()
        ?.replace(/\.git$/, '') ?? ''
    );
  }

  // ───────────── blame ─────────────

  /** git's record for one file (by absolute path), or undefined when it has no changes. */
  fileStatusFor(absolutePath: string): GitFileStatus | undefined {
    return this.byPath().get(keyOf(absolutePath));
  }

  /**
   * Who last changed each line. `contents` is the editor's CURRENT text: git then blames that instead of the file on
   * disk, so unsaved edits shift the answers correctly (new lines come back as uncommitted). null = no blame possible
   * (not in the repository, never committed, binary...).
   */
  async blame(absolutePath: string, contents?: string): Promise<FileBlame | null> {
    const relative = this.repoPathOf(absolutePath);
    if (!relative) return null;
    const args = ['blame', '--porcelain'];
    if (contents !== undefined) args.push('--contents', '-');
    args.push('--', relative);
    const result = await this.exec(args, { stdin: contents, timeoutSecs: 30 });
    return result.ok ? parseBlame(result.output) : null;
  }

  // ───────────── file contents, for diffs ─────────────

  /** The committed version: the left side of a diff. null for new/untracked files or an empty repository. */
  readAtHead(absolutePath: string): Promise<string | null> {
    return this.readAt('HEAD', absolutePath);
  }

  /** The staged version: for diffing staged changes against the committed ones. */
  readFromIndex(absolutePath: string): Promise<string | null> {
    return this.readAt('', absolutePath);
  }

  private async readAt(ref: string, absolutePath: string): Promise<string | null> {
    const relative = this.repoPathOf(absolutePath);
    if (!relative) return null;
    const result = await this.exec(['show', `${ref}:${relative}`]);
    return result.ok ? result.output : null;
  }
}

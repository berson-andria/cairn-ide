/**
 * Lane assignment and drawing data for the commit graph (lab version). Pure: no Angular, no git
 * calls, and no colors: segments and rows carry a branch NAME, the component maps it to a color.
 */
import type { GraphCommit } from '../../parser/log.parser';

/** One line of one row, as an SVG path inside a ROW_H-tall box. */
export interface GraphSegment {
  d: string;
  /** Name of the branch this line belongs to. The component turns it into a color. */
  branch: string;
}
export interface GraphRow {
  commit: GraphCommit;
  /** Lane the dot sits in. */
  col: number;
  /** Branch that owns this commit: its dot, and the line towards its first parent. */
  branch: string;
  merge: boolean;
  /** Refs on this commit that add nothing: no commits of their own, so no color and no legend entry. */
  bare: string[];
  segments: GraphSegment[];
}

export const ROW_H = 26;
export const LANE_W = 14;
export const MAX_LANES = 10;
const MID = ROW_H / 2;

export const laneX = (lane: number) => 8 + lane * LANE_W;

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "3 hours ago", "yesterday"... from an ISO 8601 date (GitCommit.date). */
export function timeAgo(isoDate: string, now = Date.now()): string {
  const seconds = (Date.parse(isoDate) - now) / 1000;
  if (Number.isNaN(seconds)) return '';
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** True for refs that are branches (local or remote): not tags, not HEAD / origin/HEAD. */
export const isBranchRef = (r: { kind: string; name: string }) =>
  r.kind !== 'tag' && r.name !== 'HEAD' && !r.name.endsWith('/HEAD');

type Ref = GraphCommit['refs'][number];

/** "origin/dev" -> "dev", "dev" -> "dev". Local and remote twins share a short name. */
const shortOf = (r: Ref) => (r.kind === 'remote' ? r.name.slice(r.name.indexOf('/') + 1) : r.name);

/** A lane waits for one hash and carries the ref name whose color runs through it. */
interface Lane {
  hash: string;
  branch: string; // ref name, e.g. "origin/dev"; what the component turns into a color
  short: string; // "dev": lets main and origin/main be recognised as the same branch
}

const freeLane = (lanes: (Lane | null)[]) => {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
};

/**
 * Branch a merge brought in, read from git's default merge subject with plain string operations:
 * "Merge branch 'x'", "Merge remote-tracking branch 'origin/x'", "Merge pull request #N from u/x".
 * null if the subject is anything else.
 */
function mergedBranchOf(commit: GraphCommit): string | null {
  const subject = commit.subject;

  for (const prefix of ["Merge branch '", "Merge remote-tracking branch '"]) {
    if (!subject.startsWith(prefix)) continue;
    const end = subject.indexOf("'", prefix.length);
    return end > prefix.length ? subject.slice(prefix.length, end) : null;
  }

  if (subject.startsWith('Merge pull request #')) {
    const from = subject.indexOf(' from ');
    if (from === -1) return null;
    const rest = subject.slice(from + ' from '.length);
    const space = rest.indexOf(' ');
    const ref = space === -1 ? rest : rest.slice(0, space); // "user/feature"
    const slash = ref.indexOf('/');
    return slash === -1 || slash === ref.length - 1 ? null : ref.slice(slash + 1);
  }
  return null;
}

interface Pick {
  name: string | null;
  short: string | null;
  /** Refs on the commit that do not name its line. */
  bare: string[];
}

/**
 * Decides which ref names the line at a commit, and which refs are "bare": branches that were
 * created here but have no commits of their own, so they must not take over the line.
 *
 * - The primary branch always names the line, even in the middle of another branch's history:
 *   everything below it in that segment is on the primary.
 * - A commit with no line arriving (a tip) is named by one branch: the one that is pushed (has a
 *   remote ref), else the checked-out one, else the first. Other branch names on it are bare.
 * - A commit on a line that already arrives is not named by a ref, except for the pushed twin of
 *   the line (local `dev` turning into `origin/dev`: the push boundary). Everything else is bare.
 * `main` and `origin/main` count as one branch here. Which of the two is used is decided by the
 * rules above, so the pushed/local difference stays visible.
 */
function pickRef(commit: GraphCommit, lane: Lane | null, primary: string | null): Pick {
  const refs = commit.refs.filter(isBranchRef);
  const groups = new Map<string, Ref[]>();
  for (const r of refs) {
    const k = shortOf(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const keys = [...groups.keys()];
  const hasRemote = (k: string) => groups.get(k)!.some((r) => r.kind === 'remote');

  let chosen: string | undefined;
  if (primary && groups.has(primary)) {
    chosen = primary;
  } else if (lane) {
    chosen = keys.find(
      (k) =>
        k === lane.short && (hasRemote(k) || groups.get(k)!.some((r) => r.name === lane.branch)),
    );
  } else {
    chosen =
      keys.find(hasRemote) ?? keys.find((k) => groups.get(k)!.some((r) => r.current)) ?? keys[0];
  }

  if (chosen === undefined) return { name: null, short: null, bare: refs.map((r) => r.name) };
  const group = groups.get(chosen)!;
  const name = (group.find((r) => r.kind === 'remote') ?? group[0]).name;
  return {
    name,
    short: chosen,
    bare: refs.filter((r) => shortOf(r) !== chosen).map((r) => r.name),
  };
}

/**
 * The primary branch as a short name. GitService may hand over "main" or "origin/main": if the
 * value is a remote ref that exists in the log, drop the remote prefix.
 */
function primaryShortName(commits: GraphCommit[], primary: string | null): string | null {
  if (!primary) return null;
  for (const c of commits) {
    for (const r of c.refs) if (r.kind === 'remote' && r.name === primary) return shortOf(r);
  }
  return primary;
}

/**
 * Assigns every commit a lane and draws the lines for its row.
 * Commits must be in topological order (children before parents), which is what
 * `git log --topo-order` gives. `lanes[i]` is the hash that lane i is waiting for.
 *
 * Colors are decided by refs, walking from the newest commit down (see pickRef). A line carries
 * a ref NAME downwards until a commit that a ref names takes it over. The component maps names to
 * colors. `primary` comes from git (GitService), never from a hardcoded list.
 */
export function layoutGraph(
  commits: GraphCommit[],
  options: { primary?: string | null } = {},
): { rows: GraphRow[]; lanes: number } {
  const primary = primaryShortName(commits, options.primary ?? null);
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  let lanes: (Lane | null)[] = [];
  let widest = 1;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = lanes.slice();
    const waiting = before.filter((l): l is Lane => l?.hash === commit.hash);
    // When several lines arrive, the primary's line names the commit; else the first one.
    const arriving = waiting.find((l) => l.short === primary) ?? waiting[0] ?? null;
    const pick = pickRef(commit, arriving, primary);

    let col = lanes.findIndex((l) => l?.hash === commit.hash);
    const fallback = `~${commit.hash.slice(0, 7)}`;
    const branch = pick.name ?? arriving?.branch ?? fallback;
    const short = pick.short ?? arriving?.short ?? fallback;
    if (col === -1) {
      col = freeLane(lanes); // a tip: nothing above it
      lanes[col] = { hash: commit.hash, branch, short };
    }

    const segments: GraphSegment[] = [];
    const x = laneX(col);

    // Lines that arrive from above: through-lanes, and lanes ending at this commit.
    before.forEach((lane, i) => {
      if (!lane) return;
      const xi = laneX(i);
      if (lane.hash !== commit.hash) {
        segments.push({ d: `M${xi} 0V${ROW_H}`, branch: lane.branch });
      } else if (i === col) {
        segments.push({ d: `M${xi} 0V${MID}`, branch: lane.branch });
      } else {
        segments.push({ d: `M${xi} 0Q${xi} ${MID} ${x} ${MID}`, branch: lane.branch });
      }
    });

    // Every lane that was waiting for this commit is done, except the one it sits in.
    lanes = lanes.map((l, i) => (l?.hash === commit.hash && i !== col ? null : l));

    // Lines that leave downwards, one per parent.
    const out: { lane: number; branch: string }[] = [];
    if (commit.parents.length === 0) {
      lanes[col] = null;
    } else {
      lanes[col] = { hash: commit.parents[0], branch, short }; // first parent: same line continues
      out.push({ lane: col, branch });
      for (const parent of commit.parents.slice(1)) {
        let j = lanes.findIndex((l) => l?.hash === parent);
        if (j === -1) {
          j = freeLane(lanes);
          // A new line starts here: named by the parent's own ref, else by the merge subject.
          const parentCommit = byHash.get(parent);
          const named = parentCommit ? pickRef(parentCommit, null, primary) : null;
          const name = named?.name ?? mergedBranchOf(commit) ?? `~${parent.slice(0, 7)}`;
          lanes[j] = { hash: parent, branch: name, short: named?.short ?? name };
        }
        out.push({ lane: j, branch: lanes[j]!.branch });
      }
    }
    for (const { lane: j, branch: b } of out) {
      segments.push({
        d:
          j === col
            ? `M${x} ${MID}V${ROW_H}`
            : `M${x} ${MID}Q${laneX(j)} ${MID} ${laneX(j)} ${ROW_H}`,
        branch: b,
      });
    }

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    widest = Math.max(widest, before.length, lanes.length, col + 1);
    rows.push({ commit, col, branch, merge: commit.parents.length > 1, bare: pick.bare, segments });
  }
  return { rows, lanes: widest };
}

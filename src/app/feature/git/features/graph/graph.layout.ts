/** Lane assignment and drawing data for the commit graph. Pure: no Angular, no git calls. */
import type { GraphCommit } from '../../parser/log.parser';

/** One line of one row, as an SVG path inside a ROW_H-tall box. */
export interface GraphSegment {
  d: string;
  /** Color index of the line this segment belongs to (not a lane number). */
  color: number;
}
export interface GraphRow {
  commit: GraphCommit;
  /** Lane the dot sits in. */
  col: number;
  /** Color index of the commit: its dot, and the line towards its first parent. */
  color: number;
  merge: boolean;
  segments: GraphSegment[];
}

export const ROW_H = 26;
export const LANE_W = 14;
export const MAX_LANES = 10;
const MID = ROW_H / 2;

export const laneX = (lane: number) => 8 + lane * LANE_W;

/**
 * Assigns every commit a lane and draws the lines for its row.
 * Commits must be in topological order (children before parents), which is what
 * `git log --topo-order` gives. `lanes[i]` is the hash that lane i is waiting for.
 */

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

export interface GraphSegment {
  d: string;
  /** Color index of the line this segment belongs to (not a lane number). */
  color: number;
}

export interface GraphRow {
  commit: GraphCommit;
  /** Lane the dot sits in. */
  col: number;
  /** Color index of the commit: its dot, and the line towards its first parent. */
  color: number;
  merge: boolean;
  segments: GraphSegment[];
}

/** A lane waits for one hash and keeps the color of the line running through it. */
interface Lane {
  hash: string;
  color: number;
}

const freeLane = (lanes: (Lane | null)[]) => {
  const i = lanes.indexOf(null);
  return i === -1 ? lanes.length : i;
};

export function layoutGraph(commits: GraphCommit[]): { rows: GraphRow[]; lanes: number } {
  let lanes: (Lane | null)[] = [];
  let nextColor = 0;
  let widest = 1;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = lanes.slice();
    let col = lanes.findIndex((l) => l?.hash === commit.hash);
    let color: number;
    if (col === -1) {
      col = freeLane(lanes); // a branch tip: nothing above it
      color = nextColor++;
      lanes[col] = { hash: commit.hash, color };
    } else {
      color = lanes[col]!.color;
    }

    const segments: GraphSegment[] = [];
    const x = laneX(col);

    // Lines that arrive from above: through-lanes, and lanes ending at this commit.
    before.forEach((lane, i) => {
      if (!lane) return;
      const xi = laneX(i);
      if (lane.hash !== commit.hash) {
        segments.push({ d: `M${xi} 0V${ROW_H}`, color: lane.color });
      } else if (i === col) {
        segments.push({ d: `M${xi} 0V${MID}`, color: lane.color });
      } else {
        segments.push({ d: `M${xi} 0Q${xi} ${MID} ${x} ${MID}`, color: lane.color });
      }
    });

    // Every lane that was waiting for this commit is done, except the one it sits in.
    lanes = lanes.map((l, i) => (l?.hash === commit.hash && i !== col ? null : l));

    // Lines that leave downwards, one per parent.
    const out: { lane: number; color: number }[] = [];
    if (commit.parents.length === 0) {
      lanes[col] = null;
    } else {
      lanes[col] = { hash: commit.parents[0], color }; // first parent: same line, same color
      out.push({ lane: col, color });
      for (const parent of commit.parents.slice(1)) {
        let j = lanes.findIndex((l) => l?.hash === parent);
        if (j === -1) {
          j = freeLane(lanes);
          lanes[j] = { hash: parent, color: nextColor++ }; // a new line starts here
        }
        out.push({ lane: j, color: lanes[j]!.color });
      }
    }
    for (const { lane: j, color: c } of out) {
      segments.push({
        d:
          j === col
            ? `M${x} ${MID}V${ROW_H}`
            : `M${x} ${MID}Q${laneX(j)} ${MID} ${laneX(j)} ${ROW_H}`,
        color: c,
      });
    }

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    widest = Math.max(widest, before.length, lanes.length, col + 1);
    rows.push({ commit, col, color, merge: commit.parents.length > 1, segments });
  }
  return { rows, lanes: widest };
}

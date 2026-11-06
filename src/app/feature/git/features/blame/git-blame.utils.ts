import type { BlameCommit, BlameLine } from '../../parser/git-parsers';

export function relativeTime(epochSeconds: number, now = Date.now()): string {
  const seconds = (epochSeconds * 1000 - now) / 1000; // negative = in the past
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** The text after the current line: "Ada Lovelace, 3 months ago • fix the parser". null = show nothing. */
export function describeBlameLine(
  entry: BlameLine | undefined,
  commit: BlameCommit | undefined,
  lineText: string,
  now = Date.now(),
): string | null {
  if (!entry || !commit) return null;
  // The line was edited after this blame was taken (a fresh blame follows a moment later).
  if (entry.text !== lineText) return 'Unsaved change';
  if (commit.uncommitted) return 'Uncommitted changes';
  const summary = commit.summary.length > 80 ? commit.summary.slice(0, 79) + '…' : commit.summary;
  return `${commit.author}, ${relativeTime(commit.time, now)} • ${summary}`;
}

/** Commit text goes into a markdown hover: neutralize anything that would be read as formatting or HTML. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

export function hoverMarkdown(commit: BlameCommit, now = Date.now()): string {
  if (commit.uncommitted) return '**Uncommitted changes**';
  const when = new Date(commit.time * 1000);
  const options: any = { year: 'numeric', month: 'short', day: 'numeric' };
  const literalDate = new Intl.DateTimeFormat('en-US', options).format(when);
  return [
    ``,
    '',
    `${escapeMarkdown(commit.summary)}`,
    '## ',
    `👤**${escapeMarkdown(commit.author)}** ${escapeMarkdown(`<${commit.email}>`)}`,
    `📆**${relativeTime(commit.time, now)}** (${literalDate} - ${when.toLocaleTimeString('en-US')})`,
    `\`${commit.hash.slice(0, 8)}\``,
  ].join('\n\n');
}

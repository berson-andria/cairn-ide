export interface BlameCommit {
  hash: string;
  author: string;
  email: string;
  /** Unix seconds. */
  time: number;
  summary: string;
  /** The all-zero "commit" git uses for lines that are not committed yet (also for unsaved buffer text). */
  uncommitted: boolean;
}

export interface BlameLine {
  hash: string;
  /** The line as git saw it, without its line ending. Compared with the editor's text to spot edits made since. */
  text: string;
}

export interface FileBlame {
  commits: Map<string, BlameCommit>;
  /** Index = line number - 1. */
  lines: BlameLine[];
}

const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/**
 * Parses `git blame --porcelain`. Each line has a header ("<hash> <orig> <final> [<group size>]") and, after the
 * metadata, a content line starting with a TAB. Metadata (author, summary...) is only printed the FIRST time a
 * commit appears, so it is stored per commit and looked up by hash.
 */
export function parseBlame(stdout: string): FileBlame {
  const commits = new Map<string, BlameCommit>();
  const lines: BlameLine[] = [];
  let hash = '';
  let finalLine = 0;

  for (const raw of stdout.split('\n')) {
    if (raw.startsWith('\t')) {
      lines[finalLine - 1] = { hash, text: raw.slice(1).replace(/\r$/, '') };
      continue;
    }
    const header = BLAME_HEADER.exec(raw);
    if (header) {
      hash = header[1];
      finalLine = Number(header[2]);
      if (!commits.has(hash)) {
        commits.set(hash, {
          hash,
          author: '',
          email: '',
          time: 0,
          summary: '',
          uncommitted: /^0+$/.test(hash),
        });
      }
      continue;
    }
    const commit = commits.get(hash);
    if (!commit) continue;
    if (raw.startsWith('author ')) commit.author = raw.slice('author '.length);
    else if (raw.startsWith('author-mail '))
      commit.email = raw.slice('author-mail '.length).replace(/^<|>$/g, '');
    else if (raw.startsWith('author-time ')) commit.time = Number(raw.slice('author-time '.length));
    else if (raw.startsWith('summary ')) commit.summary = raw.slice('summary '.length);
  }
  return { commits, lines };
}

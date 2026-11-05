export interface LineMatch {
  lineNumber: number;
  text: string;
}

export interface FileSearchResult {
  path: string;
  matches: LineMatch[];
}

export interface FileNameSearchResult {
  fileName: string;
  path: string;
}

export interface SearchFilters {
  include: string; // comma-separated globs, e.g. "*.ts, src/**"
  exclude: string; // e.g. "**/*.spec.ts, dist"
  /** Search exactly these files (the open editors). null = the whole workspace. */
  onlyPaths: string[] | null;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

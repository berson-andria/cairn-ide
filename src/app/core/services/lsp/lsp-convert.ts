import type * as Monaco from 'monaco-editor';
import type * as lsp from 'vscode-languageserver-types';

// Monaco is 1-based, LSP is 0-based. Both count columns in UTF-16 units.
export const toLspPosition = (p: Monaco.IPosition): lsp.Position => ({
  line: p.lineNumber - 1,
  character: p.column - 1,
});

export const toLspRange = (r: Monaco.IRange): lsp.Range => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});

export const toMonacoRange = (r: lsp.Range): Monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

export function toMarkdownStrings(contents: lsp.Hover['contents']): Monaco.IMarkdownString[] {
  const list = Array.isArray(contents) ? contents : [contents];
  return list.map((item) => {
    if (typeof item === 'string') return { value: item };
    if ('language' in item) return { value: '```' + item.language + '\n' + item.value + '\n```' };
    return { value: item.value };
  });
}

export function toMarker(monaco: typeof Monaco, d: lsp.Diagnostic): Monaco.editor.IMarkerData {
  const S = monaco.MarkerSeverity;
  const severities: Record<number, Monaco.MarkerSeverity> = {
    1: S.Error,
    2: S.Warning,
    3: S.Info,
    4: S.Hint,
  };
  const r = toMonacoRange(d.range);
  return {
    severity: severities[d.severity ?? 1] ?? S.Error,
    message: <string>d.message,
    source: d.source,
    code: d.code !== undefined ? String(d.code) : undefined,
    startLineNumber: r.startLineNumber,
    startColumn: r.startColumn,
    endLineNumber: r.endLineNumber,
    endColumn: r.endColumn,
    tags: d.tags?.map((t) =>
      t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated,
    ),
  };
}

export function toCompletionItem(
  monaco: typeof Monaco,
  item: lsp.CompletionItem,
  defaultRange: Monaco.IRange,
): Monaco.languages.CompletionItem {
  const K = monaco.languages.CompletionItemKind;
  const kinds: Record<number, Monaco.languages.CompletionItemKind> = {
    1: K.Text,
    2: K.Method,
    3: K.Function,
    4: K.Constructor,
    5: K.Field,
    6: K.Variable,
    7: K.Class,
    8: K.Interface,
    9: K.Module,
    10: K.Property,
    11: K.Unit,
    12: K.Value,
    13: K.Enum,
    14: K.Keyword,
    15: K.Snippet,
    16: K.Color,
    17: K.File,
    18: K.Reference,
    19: K.Folder,
    20: K.EnumMember,
    21: K.Constant,
    22: K.Struct,
    23: K.Event,
    24: K.Operator,
    25: K.TypeParameter,
  };

  let insertText = item.insertText ?? item.label;
  let range: Monaco.IRange | Monaco.languages.CompletionItemRanges = defaultRange;

  const edit = item.textEdit;
  if (edit) {
    insertText = edit.newText;
    if ('range' in edit) {
      const r = toMonacoRange(edit.range);
      // Monaco only accepts single-line replace ranges here.
      if (r.startLineNumber === r.endLineNumber) range = r;
    } else {
      const insert = toMonacoRange(edit.insert);
      const replace = toMonacoRange(edit.replace);
      if (
        insert.startLineNumber === insert.endLineNumber &&
        replace.startLineNumber === replace.endLineNumber
      ) {
        range = { insert, replace };
      }
    }
  }

  const doc = item.documentation;
  return {
    label: item.labelDetails
      ? {
          label: item.label,
          detail: item.labelDetails.detail,
          description: item.labelDetails.description,
        }
      : item.label,
    kind: kinds[item.kind ?? 1] ?? K.Text,
    detail: item.detail,
    documentation: doc ? (typeof doc === 'string' ? doc : { value: doc.value }) : undefined,
    insertText,
    range,
    insertTextRules:
      item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits?.map((e) => ({
      range: toMonacoRange(e.range),
      text: e.newText,
    })),
    tags: item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
  };
}

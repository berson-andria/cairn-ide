import type * as Monaco from 'monaco-editor';

type Language = Monaco.languages.IMonarchLanguage;

interface Spec {
  load: () => Promise<{ language: Language }>;
  /** Literals to color as constants (orange in One Dark). */
  constants?: RegExp;
}

/**
 * Languages to enhance. Add more by copying an entry; the import path is
 * node_modules/monaco-editor/esm/vs/languages/definitions/<id>/<id>.js
 */
const SPECS: Record<string, Spec> = {
  typescript: {
    // @ts-ignore - deep import, resolved by the package's exports map
    load: () => import('monaco-editor/languages/definitions/typescript/typescript'),
    constants: /\b(?:true|false|null|undefined)\b/,
  },
  javascript: {
    // @ts-ignore
    load: () => import('monaco-editor/languages/definitions/javascript/javascript'),
    constants: /\b(?:true|false|null|undefined)\b/,
  },
  python: {
    // @ts-ignore
    load: () => import('monaco-editor/languages/definitions/python/python'),
    constants: /\b(?:True|False|None)\b/,
  },
  rust: {
    // @ts-ignore
    load: () => import('monaco-editor/languages/definitions/rust/rust'),
  },
};

interface Stats {
  functionRules: number;
  operators: number;
  typeKeywords: number;
  allCaps: number;
}

/**
 * The built-in grammars label every lowercase word that isn't a keyword as 'identifier'.
 * Rewrite the tokenizer so that:
 *   name(            -> 'function'
 *   true/false/...   -> 'constant'
 *   ALL_CAPS         -> 'constant'  (was a class)
 *   string, number.. -> 'type'      (was 'keyword')
 *   = + - ...        -> 'operator'  (was 'delimiter', which also covers ; , .)
 * Rules are found by shape, not position. `stats` reports what was actually changed.
 */
function enhance(language: Language, constants?: RegExp): { language: Language; stats: Stats } {
  const lang = structuredClone(language) as Language;
  const stats: Stats = { functionRules: 0, operators: 0, typeKeywords: 0, allCaps: 0 };

  for (const [state, rules] of Object.entries(lang.tokenizer)) {
    const out: any[] = [];
    for (const rule of rules as any[]) {
      const action = Array.isArray(rule) ? rule[1] : undefined;
      const cases = action && typeof action === 'object' ? action.cases : undefined;

      if (cases) {
        if (cases['@typeKeywords'] === 'keyword') { cases['@typeKeywords'] = 'type'; stats.typeKeywords++; }
        if (cases['@operators'] === 'delimiter') { cases['@operators'] = 'operator'; stats.operators++; }
      }

      if (cases && cases['@default'] === 'identifier' && rule[0] instanceof RegExp) {
        if (constants) out.push([constants, 'constant']);
        out.push([
          new RegExp(`(?:${rule[0].source})(?=\\s*\\()`),
          { cases: { ...cases, '@default': 'function' } },
        ]);
        stats.functionRules++;
      }

      if (action === 'type.identifier' && rule[0] instanceof RegExp && rule[0].source.startsWith('[A-Z]')) {
        out.push([/[A-Z][A-Z0-9_$]+(?![\w$])/, 'constant']);
        stats.allCaps++;
      }
      out.push(rule);
    }
    lang.tokenizer[state] = out;
  }
  return { language: lang, stats };
}

/**
 * Call (and await) once, before any model is created.
 *
 * The finished grammar is installed with setMonarchTokensProvider(id, <object>), NOT a promise or a
 * lazy factory: Monaco's own language registration can run after ours and replace a factory,
 * but it never replaces an already-installed tokenizer.
 */
export async function enhanceBuiltInLanguages(monaco: typeof Monaco): Promise<void> {
  await Promise.all(
    Object.entries(SPECS).map(async ([id, spec]) => {
      try {
        const mod = await spec.load();
        const { language, stats } = enhance(mod.language, spec.constants);
        monaco.languages.setMonarchTokensProvider(id, language);
        if (stats.functionRules === 0) {
          console.warn(
            `[monaco-enhance] '${id}': identifier rule not found, grammar shape differs from what I expected`,
            { states: Object.fromEntries(Object.entries(mod.language.tokenizer).map(([k, v]) => [k, (v as any[]).length])) },
          );
        } else {
          console.info(`[monaco-enhance] '${id}' patched`, stats);
        }
      } catch (e) {
        console.error(`[monaco-enhance] '${id}' failed, using Monaco's built-in tokenizer`, e);
      }
    }),
  );
}

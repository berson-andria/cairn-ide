import oneDarkProJson from '../../../assets/theme/onedarkpro.json';
import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class ThemeConfigService {
  private useDarkerVariant = false;
  private allowBoldStyles = false;

  initOneDarkProTheme(monacoEngine: any): void {
    const monacoRules: any[] = [];

    if (oneDarkProJson.tokenColors) {
      oneDarkProJson.tokenColors.forEach((token: any) => {
        if (!token.scope || !token.settings.foreground) return;

        const scopes = Array.isArray(token.scope)
          ? token.scope
          : token.scope.split(',').map((s: string) => s.trim());

        scopes.forEach((scopeString: string) => {
          const cleanColor = token.settings.foreground.replace('#', '');

          // ⚡ CHECK BOLD SPECS: If bold is disabled globally, treat it as plain text line styles
          let cleanStyle = token.settings.fontStyle || '';
          if (!this.allowBoldStyles && cleanStyle.toLowerCase().includes('bold')) {
            cleanStyle = cleanStyle.replace(/bold/gi, '').trim();
          }

          monacoRules.push({ token: scopeString, foreground: cleanColor, fontStyle: cleanStyle });

          const scopeParts = scopeString.split('.');
          for (let i = 1; i <= scopeParts.length; i++) {
            const subScope = scopeParts.slice(0, i).join('.');
            monacoRules.push({ token: subScope, foreground: cleanColor, fontStyle: cleanStyle });
          }
        });
      });
    }

    const findColorForScope = (targetScope: string): string => {
      const match = oneDarkProJson.tokenColors.find((t: any) => {
        if (Array.isArray(t.scope)) return t.scope.includes(targetScope);
        return t.scope === targetScope;
      });
      return match?.settings?.foreground?.replace('#', '') || '';
    };

    const keywordColor =
      findColorForScope('keyword') || findColorForScope('keyword.control') || 'c678dd';
    const stringColor = findColorForScope('string') || '98c379';
    const commentColor = findColorForScope('comment') || '7f848e';
    const numberColor = findColorForScope('constant.numeric') || 'd19a66';
    const typeColor =
      findColorForScope('entity.name.type') || findColorForScope('support.type') || 'e5c07b';
    const textColor = oneDarkProJson.colors?.['editor.foreground']?.replace('#', '') || 'abb2bf';

    const functionColor = findColorForScope('entity.name.function') || '61afef';

    const keywordFontStyle = this.allowBoldStyles ? 'bold' : '';

    monacoRules.push(
      { token: '', foreground: textColor }, // Global default text color
      { token: 'keyword', foreground: keywordColor, fontStyle: keywordFontStyle },
      { token: 'string', foreground: stringColor },
      { token: 'comment', foreground: commentColor, fontStyle: 'italic' },
      { token: 'number', foreground: numberColor },
      { token: 'type', foreground: typeColor },
      { token: 'identifier', foreground: textColor },
      { token: 'tag', foreground: 'e06c75' },
      { token: 'delimiter', foreground: 'abb2bf' },
      { token: 'annotation', foreground: 'd19a66' },
      { token: 'variable', foreground: 'e06c75' },

      // ⚡ SOLVED: Explicitly mapping function structures inside Monaco's core engine rules
      { token: 'keyword.function', foreground: functionColor },
      { token: 'entity.name.function', foreground: functionColor },
    );

    const customColors = { ...(oneDarkProJson.colors || {}) };
    if (this.useDarkerVariant) {
      customColors['editor.background'] = '#1e2227';
      // customColors['editor.lineHighlightBackground'] = '#2c313c';
      customColors['editorGroupHeader.tabsBackground'] = '#181a1f';
    }

    monacoEngine.editor.defineTheme('one-dark-pro', {
      base: 'vs-dark',
      inherit: true,
      rules: monacoRules,
      colors: customColors,
    });

    monacoEngine.editor.setTheme('one-dark-pro');
  }

  public flushThemeColorsToCssVariables(): void {
    const colors = { ...(oneDarkProJson.colors || {}) };
    if (this.useDarkerVariant) {
      colors['editor.background'] = '#1e2227';
      colors['editor.lineHighlightBackground'] = '#2c313c';
      colors['editorGroupHeader.tabsBackground'] = '#181a1f';
    }
    const root = document.documentElement;

    root.style.setProperty('--title-bar-bg', colors['titleBar.activeBackground'] || '#23272e');
    root.style.setProperty('--title-bar-text', colors['titleBar.activeForeground'] || '#9da5b4');

    root.style.setProperty('--activity-bar-bg', colors['activityBar.background'] || '#23272e');
    root.style.setProperty('--activity-bar-text', colors['activityBar.foreground'] || '#d7dae0');
    root.style.setProperty('--activity-bar-hover-bg', colors['tab.hoverBackground'] || '#323842');

    root.style.setProperty('--explorer-bg', colors['sideBar.background'] || '#1e2227');
    root.style.setProperty('--explorer-text', colors['sideBar.foreground'] || '#abb2bf');
    root.style.setProperty('--explorer-item-hover-bg', colors['list.hoverBackground'] || '#2c313a');
    root.style.setProperty(
      '--explorer-item-active-bg',
      colors['list.activeSelectionBackground'] || '#2c313a',
    );
    root.style.setProperty('--editor-panel-bg', colors['editor.background'] || '#23272e');
    root.style.setProperty(
      '--editor-tab-bg-inactive',
      colors['tab.inactiveBackground'] || '#1e2227',
    );
    root.style.setProperty(
      '--editor-tab-text-inactive',
      colors['titleBar.inactiveForeground'] || '#dcdcdce3',
    );
    // root.style.setProperty('--editor-tab-bg-active', colors['tab.activeBackground'] || '#23272e');
    root.style.setProperty('--editor-tab-bg-active', '#3a4049');

    root.style.setProperty('--editor-tab-hover-bg', colors['list.hoverBackground'] || '#2c313a');
    root.style.setProperty('--editor-tab-text-active', colors['tab.activeForeground'] || '#dcdcdc');

    root.style.setProperty(
      '--agent-panel-bg',
      colors['agentsPanel.background'] || colors['sideBar.background'] || '#1e2227',
    );
    root.style.setProperty(
      '--agent-panel-text',
      colors['agentsPanel.foreground'] || colors['sideBar.foreground'] || '#abb2bf',
    );
    root.style.setProperty(
      '--agent-panel-border',
      colors['agentsPanel.border'] || colors['panel.border'] || '#3e4452',
    );

    // 💻 Terminal Panel Mappings
    root.style.setProperty('--terminal-bg', colors['terminal.background'] || '#23272e');
    root.style.setProperty('--terminal-text', colors['terminal.foreground'] || '#abb2bf');
    root.style.setProperty(
      '--terminal-border',
      colors['terminal.border'] || colors['panel.border'] || '#3e4452',
    );

    // 📊 Status Bar Mappings
    root.style.setProperty('--status-bar-bg', colors['statusBar.background'] || '#1e2227');
    root.style.setProperty('--status-bar-text', colors['statusBar.foreground'] || '#9da5b4');
  }

  parseOneDarkProToMonaco(oneDarkProJson: any) {
    const monacoRules: any[] = [];
    const baseColors = oneDarkProJson.colors || {};

    // Extract core baseline settings from the JSON structure
    const globalText = (baseColors['editor.foreground'] || '#abb2bf').replace('#', '');
    const globalBg = (baseColors['editor.background'] || '#23272e').replace('#', '');

    // 1. Establish absolute baseline tokens
    monacoRules.push(
      { token: '', foreground: globalText },
      { token: 'identifier', foreground: globalText },
      { token: 'delimiter', foreground: globalText },
    );

    // 2. Loop and dynamic conversion engine
    if (oneDarkProJson.tokenColors && Array.isArray(oneDarkProJson.tokenColors)) {
      oneDarkProJson.tokenColors.forEach((item: any) => {
        if (!item.scope || !item.settings || !item.settings.foreground) return;

        // Handle both string scopes and array of scopes present in this theme
        const scopes: string[] = Array.isArray(item.scope)
          ? item.scope
          : item.scope.split(',').map((s: string) => s.trim());

        const colorHex = item.settings.foreground.replace('#', '');
        const fontStyle = item.settings.fontStyle || '';

        scopes.forEach((scope: string) => {
          // --- ⚡ CRITICAL RULE FIXES FOR MONACO COMPATIBILITY ---

          // Keywords and Operators
          if (scope.startsWith('keyword') || scope.startsWith('storage')) {
            monacoRules.push({ token: 'keyword', foreground: colorHex, fontStyle });
            if (scope.includes('control')) {
              monacoRules.push({ token: 'keyword.control', foreground: colorHex, fontStyle });
            }
          }

          // Functions and Methods
          if (
            scope.includes('entity.name.function') ||
            scope.includes('variable.function') ||
            scope.includes('meta.function')
          ) {
            monacoRules.push(
              { token: 'identifier.function', foreground: colorHex },
              { token: 'meta.function', foreground: colorHex },
              { token: 'predefined', foreground: colorHex }, // maps global methods like console.log
            );
          }

          // Strings
          if (scope.startsWith('string')) {
            monacoRules.push({ token: 'string', foreground: colorHex });
            if (scope.includes('regexp')) {
              monacoRules.push({ token: 'string.regexp', foreground: colorHex });
            }
          }

          // Comments
          if (scope.startsWith('comment')) {
            monacoRules.push({ token: 'comment', foreground: colorHex, fontStyle: 'italic' });
          }

          // Numbers and Constants
          if (scope.startsWith('constant.numeric') || scope.includes('number')) {
            monacoRules.push({ token: 'number', foreground: colorHex });
          } else if (scope.startsWith('constant')) {
            monacoRules.push({ token: 'constant', foreground: colorHex });
          }

          // Types, Classes, Namespaces
          if (
            scope.includes('entity.name.type') ||
            scope.includes('entity.name.class') ||
            scope.includes('support.class')
          ) {
            monacoRules.push({ token: 'type', foreground: colorHex });
          }

          // Variables / Object Fields
          if (scope.startsWith('variable') || scope.includes('variable.field')) {
            monacoRules.push({ token: 'variable', foreground: colorHex });
          }

          // Markup Tags (HTML / XML / Template syntax)
          if (scope.includes('entity.name.tag')) {
            monacoRules.push({ token: 'tag', foreground: colorHex });
          }
          if (scope.includes('punctuation.definition.tag')) {
            monacoRules.push({ token: 'tag.id', foreground: colorHex });
          }
        });
      });
    }

    // 3. Assemble and return standard Monaco theme shape
    return {
      base: 'vs-dark', // Sets core visual baseline properties
      inherit: true,
      rules: monacoRules,
      colors: {
        // Hexes remain prefixed with '#' inside the final standalone layout colors block
        'editor.background': baseColors['editor.background'] || '#23272e',
        'editor.foreground': baseColors['editor.foreground'] || '#abb2bf',
        'editorLineNumber.foreground': baseColors['editorLineNumber.foreground'] || '#495162',
        'editorLineNumber.activeForeground':
          baseColors['editorLineNumber.activeForeground'] || '#abb2bf',
        'editor.lineHighlightBackground': baseColors['editor.lineHighlightBackground'] || '#2c313c',
        'editor.selectionBackground': baseColors['editor.selectionBackground'] || '#67769660',
        'editorCursor.foreground': baseColors['editorCursor.foreground'] || '#528bff',
        ...baseColors, // Pipes through remaining UI items natively
      },
    };
  }
}

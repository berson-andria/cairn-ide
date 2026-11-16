import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { SECTIONS, Section, SettingDef } from './settings.registry';
import { SettingsService } from './settings.service';
import { ModelsSettings } from './model-setting/models-settings';

interface Group {
  id: string;
  title: string;
  defs: SettingDef[];
}

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
  imports: [ModelsSettings],
})
export class Settings {
  readonly settings = inject(SettingsService);
  readonly categories = SECTIONS;
  readonly query = signal('');
  readonly category = signal<Section['id']>('appearance');
  readonly onlyModified = signal(false);
  readonly targetScopes = signal<Record<string, 'user' | 'workspace'>>({});
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly sectionLabels = new Map(SECTIONS.map((section) => [section.id, section.label]));
  readonly isFiltering = computed(() => this.query().trim() !== '' || this.onlyModified());

  private readonly filtered = computed(() => {
    const terms = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    return this.settings.definitions.filter((def) => {
      if (this.onlyModified() && !this.settings.isModified(def.key)) return false;
      if (!terms.length) return true;
      return terms.every((term) =>
        [def.label, def.description, def.key].join(' ').toLowerCase().includes(term),
      );
    });
  });

  readonly counts = computed(() => {
    const counts: Partial<Record<Section['id'], number>> = {};
    for (const def of this.filtered()) counts[def.section] = (counts[def.section] ?? 0) + 1;
    return counts;
  });

  readonly groups = computed<Group[]>(() => {
    const filtering = this.isFiltering();
    const groups = new Map<string, Group>();
    for (const def of this.filtered()) {
      if (!filtering && def.section !== this.category()) continue;
      const groupId = def.subsection ? `${def.section}.${def.subsection}` : def.section;
      const title = def.subsection === 'lsp' ? 'Language Server Protocol' : this.categoryLabel(def);
      if (!groups.has(groupId)) {
        groups.set(groupId, { id: groupId, title, defs: [] });
      }
      if (
        def.section === 'models' &&
        (def.key === 'models.registry' || def.key === 'models.defaultModel')
      )
        continue;
      groups.get(groupId)!.defs.push(def);
    }
    return [...groups.values()];
  });

  constructor() {
    afterNextRender(() => this.searchInput()?.nativeElement.focus());
  }

  categoryLabel(def: SettingDef): string {
    return this.sectionLabels.get(def.section) ?? def.section;
  }

  selectCategory(id: Section['id']): void {
    this.category.set(id);
    this.query.set('');
    this.onlyModified.set(false);
  }

  isCategoryActive(id: Section['id']): boolean {
    return !this.isFiltering() && this.category() === id;
  }

  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  onSearchKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.query()) {
      event.preventDefault();
      event.stopPropagation();
      this.query.set('');
    }
  }

  controlId(def: SettingDef): string {
    return `setting-${def.key.replace(/\./g, '-')}`;
  }
  bool(def: SettingDef): boolean {
    return this.settings.get<boolean>(def.key)();
  }
  num(def: SettingDef): number {
    return this.settings.get<number>(def.key)();
  }
  str(def: SettingDef): string {
    const value = this.settings.get(def.key)();
    return Array.isArray(value) ? value.join(', ') : String(value);
  }
  toggle(def: SettingDef): void {
    this.write(def, !this.bool(def));
  }
  onSelect(def: SettingDef, event: Event): void {
    this.write(def, (event.target as HTMLSelectElement).value);
  }
  onText(def: SettingDef, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.write(def, text);
  }
  onStringList(def: SettingDef, event: Event): void {
    const text = (event.target as HTMLTextAreaElement).value;
    this.write(
      def,
      text
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  onNumber(def: SettingDef, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!Number.isNaN(input.valueAsNumber)) this.write(def, input.valueAsNumber);
    input.value = String(this.num(def));
  }

  targetScope(def: SettingDef): 'user' | 'workspace' {
    if (def.scope !== 'both') return def.scope;
    return this.targetScopes()[def.key] ?? 'user';
  }

  selectScope(def: SettingDef, scope: 'user' | 'workspace'): void {
    this.targetScopes.update((targets) => ({ ...targets, [def.key]: scope }));
  }

  reset(def: SettingDef): void {
    this.settings.reset(def.key, this.targetScope(def));
  }

  sourceLabel(def: SettingDef): string {
    const source = this.settings.sourceOf(def.key);
    return source === 'default' ? 'Default' : source === 'user' ? 'User' : 'Workspace';
  }

  stringListValue(def: SettingDef): string {
    const value = this.settings.get<string[]>(def.key)();
    return value.join('\n');
  }

  private write(def: SettingDef, value: unknown): void {
    this.settings.set(def.key, value, this.targetScope(def));
  }
}

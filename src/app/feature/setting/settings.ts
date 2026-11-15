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
import { SettingDef, SETTING_CATEGORIES, CategoryId, SettingOption } from './settings.model';
import { SettingsService } from './settings.service';

interface Group {
  id: string;
  title: string;
  defs: SettingDef[];
}

/** Settings editor. Open it in your modal: dialogService.open(Settings). The modal owns the background. */
@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.html',
  styleUrl: './settings.scss',
})
export class Settings {
  readonly settings = inject(SettingsService);
  readonly categories = SETTING_CATEGORIES;

  readonly query = signal('');
  readonly category = signal<CategoryId>('workbench');
  readonly onlyModified = signal(false);

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');
  private readonly categoryLabels = new Map(SETTING_CATEGORIES.map((c) => [c.id, c.label]));

  readonly isFiltering = computed(() => this.query().trim() !== '' || this.onlyModified());

  /** Settings matching the search box / "modified only" (all categories). */
  private readonly filtered = computed(() => {
    const terms = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    const modifiedOnly = this.onlyModified();
    return this.settings.definitions.filter((d) => {
      if (modifiedOnly && !this.settings.isModified(d.key)) return false;
      if (!terms.length) return true;
      const haystack = [
        d.label,
        d.description,
        d.key,
        this.categoryLabel(d),
        d.section,
        ...(d.keywords ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  });

  /** Per-category result counts for the nav (follows the current filter). */
  readonly counts = computed(() => {
    const counts: Partial<Record<CategoryId, number>> = {};
    for (const d of this.filtered()) counts[d.category] = (counts[d.category] ?? 0) + 1;
    return counts;
  });

  /** Browsing: the selected category split by section. Filtering: all matches split by category. */
  readonly groups = computed<Group[]>(() => {
    const filtering = this.isFiltering();
    const selected = this.category();
    const groups = new Map<string, Group>();

    for (const d of this.filtered()) {
      if (!filtering && d.category !== selected) continue;
      const id = filtering ? d.category : d.section;
      const title = filtering ? this.categoryLabel(d) : d.section;
      if (!groups.has(id)) groups.set(id, { id, title, defs: [] });
      groups.get(id)!.defs.push(d);
    }
    return [...groups.values()];
  });

  constructor() {
    afterNextRender(() => this.searchInput()?.nativeElement.focus());
  }

  // ------------------------------------------------------------- navigation
  selectCategory(id: CategoryId): void {
    this.category.set(id);
    this.query.set('');
    this.onlyModified.set(false);
  }

  isCategoryActive(id: CategoryId): boolean {
    return !this.isFiltering() && this.category() === id;
  }

  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  onSearchKey(event: KeyboardEvent): void {
    // First Escape clears the search; only an empty search lets Escape reach the modal.
    if (event.key === 'Escape' && this.query()) {
      event.preventDefault();
      event.stopPropagation();
      this.query.set('');
    }
  }

  // ------------------------------------------------------------ value access
  categoryLabel(def: SettingDef): string {
    return this.categoryLabels.get(def.category) ?? '';
  }

  controlId(def: SettingDef): string {
    return 'setting-' + def.key.replace(/\./g, '-');
  }

  bool(def: SettingDef): boolean {
    return this.settings.get<boolean>(def.key);
  }
  num(def: SettingDef): number {
    return this.settings.get<number>(def.key);
  }
  str(def: SettingDef): string {
    return this.settings.get<string>(def.key);
  }

  /** Description of the currently selected option, when the options have one. */
  selectedHint(def: SettingDef): string {
    const current = this.str(def);
    return def.options?.find((o: SettingOption) => o.value === current)?.description ?? '';
  }

  // ---------------------------------------------------------------- handlers
  toggle(def: SettingDef): void {
    this.settings.set(def.key, !this.bool(def));
  }

  onSelect(def: SettingDef, event: Event): void {
    this.settings.set(def.key, (event.target as HTMLSelectElement).value);
  }

  pick(def: SettingDef, value: string): void {
    this.settings.set(def.key, value);
  }

  onText(def: SettingDef, event: Event): void {
    this.settings.set(def.key, (event.target as HTMLInputElement).value);
  }

  /** Commit on change / blur / Enter. Out-of-range input is clamped and the field shows the real value. */
  onNumber(def: SettingDef, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!Number.isNaN(input.valueAsNumber)) this.settings.set(def.key, input.valueAsNumber);
    input.value = String(this.num(def));
  }
}

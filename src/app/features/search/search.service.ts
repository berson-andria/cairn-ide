import { inject, Injectable, NgZone } from '@angular/core';
import { TauriBridgeService } from '../../core/services/tauri/tauri-bridge.service';
import { FileSearchResult, FileNameSearchResult, SearchFilters } from './search.model';

@Injectable({
  providedIn: 'root',
})
export class SearchService {
  tauri = inject(TauriBridgeService);
  ngZone = inject(NgZone);

  seachWorkspaceKeyword(
    folderPath: string,
    query: string,
    filters?: SearchFilters,
  ): Promise<FileSearchResult[]> {
    return this.tauri.invokeCommand<FileSearchResult[]>('global_search', {
      workspacePath: folderPath,
      query,
      options: filters ?? null,
    });
  }

  // search_files
  searchWorkspaceFile(folderPath: string, keyword: string): Promise<FileNameSearchResult[]> {
    return this.tauri
      .invokeCommand<FileNameSearchResult[]>('search_files', {
        rootPath: folderPath,
        query: keyword,
      })
      .catch((err) => {
        console.error(err);
        return [] as FileNameSearchResult[];
      });
  }
}

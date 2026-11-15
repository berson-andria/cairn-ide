export interface PaginationMeta {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface PaginatedData<T> {
  data: T[];
  meta: PaginationMeta;
}

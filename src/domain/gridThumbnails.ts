import type { BrowseRow } from './browseModel';
import type { BrowseViewMode, GridThumbnailState } from './types';

export interface GridThumbnailBatch {
  rowsToLoad: BrowseRow[];
  nextState: Record<string, GridThumbnailState>;
}

export function planGridThumbnailBatch(
  rows: BrowseRow[],
  current: Record<string, GridThumbnailState>,
): GridThumbnailBatch {
  const rowsToLoad = rows.filter((row) => !current[row.id]);

  if (rowsToLoad.length === 0) {
    return {
      rowsToLoad: [],
      nextState: current,
    };
  }

  const nextState = { ...current };
  for (const row of rowsToLoad) {
    nextState[row.id] = { status: 'loading' };
  }

  return {
    rowsToLoad,
    nextState,
  };
}

export function planThumbnailRowsForView(
  rows: BrowseRow[],
  viewMode: BrowseViewMode,
): BrowseRow[] {
  const limit = viewMode === 'grid' ? 24 : 48;
  return rows.slice(0, limit);
}

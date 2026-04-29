import type { BrowseRow } from './browseModel';

export function supportsAssetThumbnail(row: BrowseRow): boolean {
  return (
    row.kind === 'file' &&
    row.isPreviewable &&
    row.fileCategory === 'images'
  );
}

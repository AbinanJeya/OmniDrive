import { describe, expect, it } from 'vitest';
import type { BrowseRow } from './browseModel';
import { planGridThumbnailBatch, planThumbnailRowsForView } from './gridThumbnails';

function makeRow(id: string): BrowseRow {
  return {
    id,
    entry: {
      kind: 'file',
      id,
      name: `${id}.png`,
      virtualPath: `/${id}.png`,
      node: {
        id,
        googleId: id,
        accountId: 'drive-a',
        filename: `${id}.png`,
        isFolder: false,
        sizeBytes: 1024,
        virtualPath: `/${id}.png`,
        mimeType: 'image/png',
        fileCategory: 'images',
        fileExtension: 'png',
        isPreviewable: true,
      },
    },
    name: `${id}.png`,
    virtualPath: `/${id}.png`,
    kind: 'file',
    fileCategory: 'images',
    sizeBytes: 1024,
    modifiedTime: '2026-04-19T10:00:00Z',
    sourceAccountIds: ['drive-a'],
    accountLabels: ['A'],
    typeLabel: 'Image',
    mimeType: 'image/png',
    fileExtension: 'png',
    isPreviewable: true,
  };
}

describe('planGridThumbnailBatch', () => {
  it('marks every missing row as loading in one batch', () => {
    const rows = [makeRow('one'), makeRow('two')];

    const batch = planGridThumbnailBatch(rows, {});

    expect(batch.rowsToLoad.map((row) => row.id)).toEqual(['one', 'two']);
    expect(batch.nextState).toEqual({
      one: { status: 'loading' },
      two: { status: 'loading' },
    });
  });

  it('does not retry rows that already have a thumbnail state', () => {
    const rows = [makeRow('one'), makeRow('two')];

    const batch = planGridThumbnailBatch(rows, {
      one: { status: 'ready', assetKind: 'image', localPath: 'cached.png' },
      two: { status: 'loading' },
    });

    expect(batch.rowsToLoad).toEqual([]);
    expect(batch.nextState).toEqual({
      one: { status: 'ready', assetKind: 'image', localPath: 'cached.png' },
      two: { status: 'loading' },
    });
  });

  it('plans thumbnails for list view as well as grid view', () => {
    const rows = Array.from({ length: 60 }, (_, index) => makeRow(`image-${index}`));

    expect(planThumbnailRowsForView(rows, 'grid')).toHaveLength(24);
    expect(planThumbnailRowsForView(rows, 'list')).toHaveLength(48);
  });
});

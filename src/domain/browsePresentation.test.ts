import { describe, expect, it } from 'vitest';
import { supportsAssetThumbnail } from './browsePresentation';
import type { BrowseRow } from './browseModel';

function makeRow(
  overrides: Partial<BrowseRow>,
): BrowseRow {
  return {
    id: 'row-1',
    entry: {
      kind: 'file',
      id: 'node-1',
      name: 'sample.png',
      virtualPath: '/sample.png',
      node: {
        id: 'node-1',
        googleId: 'google-1',
        accountId: 'drive-a',
        filename: 'sample.png',
        isFolder: false,
        sizeBytes: 1024,
        virtualPath: '/sample.png',
        mimeType: 'image/png',
        fileCategory: 'images',
        fileExtension: 'png',
        isPreviewable: true,
      },
    },
    name: 'sample.png',
    virtualPath: '/sample.png',
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
    ...overrides,
  };
}

describe('browsePresentation', () => {
  it('allows lightweight asset thumbnails only for previewable media files', () => {
    expect(supportsAssetThumbnail(makeRow({ fileCategory: 'images' }))).toBe(true);
    expect(
      supportsAssetThumbnail(
        makeRow({
          name: 'clip.mp4',
          fileCategory: 'videos',
          mimeType: 'video/mp4',
          fileExtension: 'mp4',
        }),
      ),
    ).toBe(false);
  });

  it('falls back to posters for folders and non-media files', () => {
    expect(
      supportsAssetThumbnail(
        makeRow({
          kind: 'directory',
          entry: {
            kind: 'directory',
            id: 'folder-1',
            name: 'Projects',
            virtualPath: '/Projects',
            backingFolders: [],
            children: [],
          },
          fileCategory: 'folders',
          isPreviewable: false,
        }),
      ),
    ).toBe(false);
    expect(
      supportsAssetThumbnail(
        makeRow({
          fileCategory: 'pdfs',
          mimeType: 'application/pdf',
          fileExtension: 'pdf',
        }),
      ),
    ).toBe(false);
    expect(
      supportsAssetThumbnail(
        makeRow({
          fileCategory: 'documents',
          mimeType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          fileExtension: 'docx',
        }),
      ),
    ).toBe(false);
  });
});

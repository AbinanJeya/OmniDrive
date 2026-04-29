import { describe, expect, it } from 'vitest';
import type { AccountState, UnifiedNode } from './types';
import { findDuplicateGroups, getStorageInsights } from './storageInsights';

const accounts: AccountState[] = [
  {
    accountId: 'drive-a',
    label: 'A',
    displayName: 'Drive A',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 1000,
    usedBytes: 940,
    freeBytes: 60,
  },
];

function node(overrides: Partial<UnifiedNode>): UnifiedNode {
  return {
    id: 'drive-a:file',
    googleId: 'file',
    accountId: 'drive-a',
    filename: 'File.bin',
    isFolder: false,
    sizeBytes: 100,
    virtualPath: '/File.bin',
    mimeType: 'application/octet-stream',
    modifiedTime: '2022-01-01T00:00:00Z',
    createdTime: '2022-01-01T00:00:00Z',
    viewedByMeTime: undefined,
    starred: false,
    shared: false,
    checksum: undefined,
    thumbnailState: 'unknown',
    sourceKind: 'drive',
    previewStatus: 'unsupported',
    syncVersion: 1,
    fileCategory: 'other',
    fileExtension: 'bin',
    isPreviewable: false,
    ...overrides,
  };
}

describe('storageInsights', () => {
  it('groups duplicates by checksum before falling back to name and size', () => {
    const duplicates = findDuplicateGroups([
      node({ id: 'one', googleId: 'one', checksum: 'abc', filename: 'One.pdf', sizeBytes: 100 }),
      node({ id: 'two', googleId: 'two', checksum: 'abc', filename: 'Two.pdf', sizeBytes: 100 }),
      node({ id: 'three', googleId: 'three', filename: 'Budget.xlsx', sizeBytes: 50 }),
      node({ id: 'four', googleId: 'four', filename: 'Budget.xlsx', sizeBytes: 50 }),
    ]);

    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]?.reason).toBe('checksum');
    expect(duplicates[0]?.reclaimableBytes).toBe(100);
    expect(duplicates[1]?.reason).toBe('nameAndSize');
    expect(duplicates[1]?.reclaimableBytes).toBe(50);
  });

  it('creates practical cleanup and account health insights', () => {
    const insights = getStorageInsights({
      accounts,
      nodes: [
        node({ id: 'large', sizeBytes: 900, filename: 'Archive.mov', fileCategory: 'videos' }),
        node({ id: 'old', sizeBytes: 10, filename: 'Old.txt', modifiedTime: '2021-01-01T00:00:00Z' }),
        node({ id: 'dup-a', filename: 'Copy.pdf', sizeBytes: 25 }),
        node({ id: 'dup-b', filename: 'Copy.pdf', sizeBytes: 25 }),
      ],
      now: new Date('2026-04-25T00:00:00Z'),
    });

    expect(insights.map((insight) => insight.kind)).toEqual(
      expect.arrayContaining(['lowSpace', 'largeFiles', 'oldFiles', 'duplicates']),
    );
    expect(insights.find((insight) => insight.kind === 'lowSpace')?.severity).toBe('critical');
  });
});

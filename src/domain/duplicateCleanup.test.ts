import { describe, expect, it } from 'vitest';
import {
  duplicateSelectionAccountLabels,
  duplicateSelectionBytes,
  resolveDuplicateReviewGroups,
  totalReclaimableBytes,
} from './duplicateCleanup';
import type { AccountState, LocalIndexDuplicateGroup, UnifiedNode } from './types';

const accounts: AccountState[] = [
  {
    accountId: 'drive-a',
    label: 'A',
    displayName: 'Drive A',
    email: 'a@example.com',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 10,
    usedBytes: 5,
    freeBytes: 5,
    health: 'connected',
  },
  {
    accountId: 'drive-b',
    label: 'B',
    displayName: 'Drive B',
    email: 'b@example.com',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 10,
    usedBytes: 2,
    freeBytes: 8,
    health: 'connected',
  },
];

const nodes: UnifiedNode[] = [
  {
    id: 'drive-a:file-1',
    googleId: 'file-1',
    accountId: 'drive-a',
    filename: 'Doc.pdf',
    isFolder: false,
    sizeBytes: 100,
    virtualPath: '/Docs/Doc.pdf',
    mimeType: 'application/pdf',
    fileCategory: 'pdfs',
    isPreviewable: true,
  },
  {
    id: 'drive-b:file-2',
    googleId: 'file-2',
    accountId: 'drive-b',
    filename: 'Doc.pdf',
    isFolder: false,
    sizeBytes: 100,
    virtualPath: '/Docs/Doc.pdf',
    mimeType: 'application/pdf',
    fileCategory: 'pdfs',
    isPreviewable: true,
  },
  {
    id: 'drive-a:file-3',
    googleId: 'file-3',
    accountId: 'drive-a',
    filename: 'Other.pdf',
    isFolder: false,
    sizeBytes: 50,
    virtualPath: '/Other/Other.pdf',
    mimeType: 'application/pdf',
    fileCategory: 'pdfs',
    isPreviewable: true,
  },
];

describe('resolveDuplicateReviewGroups', () => {
  it('resolves node ids and assigns the first sorted node as the keep candidate', () => {
    const groups: LocalIndexDuplicateGroup[] = [
      {
        id: 'dup-1',
        reason: 'nameAndSize',
        nodeIds: ['drive-b:file-2', 'drive-a:file-1'],
        reclaimableBytes: 100,
      },
    ];

    const result = resolveDuplicateReviewGroups(groups, nodes);

    expect(result).toHaveLength(1);
    expect(result[0]?.keepNode.id).toBe('drive-a:file-1');
    expect(result[0]?.duplicateNodes.map((node) => node.id)).toEqual(['drive-b:file-2']);
  });

  it('drops groups that cannot resolve to at least two valid nodes', () => {
    const groups: LocalIndexDuplicateGroup[] = [
      {
        id: 'dup-1',
        reason: 'checksum',
        nodeIds: ['missing-id'],
        reclaimableBytes: 100,
      },
    ];

    expect(resolveDuplicateReviewGroups(groups, nodes)).toEqual([]);
  });
});

describe('duplicate cleanup totals', () => {
  it('computes reclaimable bytes and selected account labels', () => {
    const groups = resolveDuplicateReviewGroups(
      [
        {
          id: 'dup-1',
          reason: 'checksum',
          nodeIds: ['drive-a:file-1', 'drive-b:file-2'],
          reclaimableBytes: 100,
        },
      ],
      nodes,
    );

    expect(totalReclaimableBytes(groups)).toBe(100);
    expect(duplicateSelectionBytes(groups[0]?.duplicateNodes ?? [])).toBe(100);
    expect(duplicateSelectionAccountLabels(groups[0]?.duplicateNodes ?? [], accounts)).toEqual(['B']);
  });
});

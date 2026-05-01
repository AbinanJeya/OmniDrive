import { describe, expect, it } from 'vitest';
import { computeBrowseRows } from './browseModel';
import {
  computeTransferTargetAccounts,
  planDriveTransferItems,
} from './transferModel';
import type { AccountState, UnifiedNode } from './types';

const accounts: AccountState[] = [
  {
    accountId: 'drive-a',
    label: 'A',
    displayName: 'Drive A',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 100,
    usedBytes: 30,
    freeBytes: 70,
  },
  {
    accountId: 'drive-b',
    label: 'B',
    displayName: 'Drive B',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 100,
    usedBytes: 10,
    freeBytes: 90,
  },
  {
    accountId: 'photos-a',
    label: 'P',
    displayName: 'Photos',
    sourceKind: 'photos',
    isConnected: true,
    totalBytes: 0,
    usedBytes: 0,
    freeBytes: 0,
  },
];

const nodes: UnifiedNode[] = [
  {
    id: 'drive-a:folder-projects',
    googleId: 'folder-projects',
    accountId: 'drive-a',
    filename: 'Projects',
    isFolder: true,
    sizeBytes: 0,
    virtualPath: '/Projects',
    mimeType: 'application/vnd.google-apps.folder',
    fileCategory: 'folders',
    isPreviewable: false,
  },
  {
    id: 'drive-a:folder-art',
    googleId: 'folder-art',
    accountId: 'drive-a',
    filename: 'Art',
    isFolder: true,
    sizeBytes: 0,
    virtualPath: '/Projects/Art',
    mimeType: 'application/vnd.google-apps.folder',
    fileCategory: 'folders',
    isPreviewable: false,
  },
  {
    id: 'drive-a:file-brief',
    googleId: 'file-brief',
    accountId: 'drive-a',
    filename: 'Brief.pdf',
    isFolder: false,
    sizeBytes: 100,
    virtualPath: '/Projects/Brief.pdf',
    mimeType: 'application/pdf',
    fileCategory: 'pdfs',
    isPreviewable: true,
  },
  {
    id: 'drive-a:file-logo',
    googleId: 'file-logo',
    accountId: 'drive-a',
    filename: 'Logo.png',
    isFolder: false,
    sizeBytes: 200,
    virtualPath: '/Projects/Art/Logo.png',
    mimeType: 'image/png',
    fileCategory: 'images',
    isPreviewable: true,
  },
  {
    id: 'drive-b:file-existing',
    googleId: 'file-existing',
    accountId: 'drive-b',
    filename: 'Existing.txt',
    isFolder: false,
    sizeBytes: 20,
    virtualPath: '/Existing.txt',
    mimeType: 'text/plain',
    fileCategory: 'text',
    isPreviewable: true,
  },
];

function rootRows() {
  return computeBrowseRows({
    nodes,
    accounts,
    scope: { kind: 'all' },
    category: 'all',
    folderPath: '/',
    filters: {
      entryKind: 'all',
      category: 'all',
      sourceAccountId: 'all',
      searchQuery: '',
    },
    sort: { field: 'name', direction: 'asc' },
  });
}

describe('transferModel', () => {
  it('expands a selected Drive folder into file transfers while preserving nested folders', () => {
    const folderRow = rootRows().find((row) => row.name === 'Projects');
    expect(folderRow).toBeDefined();

    const plan = planDriveTransferItems({
      rows: folderRow ? [folderRow] : [],
      nodes,
      accounts,
      targetAccountId: 'drive-b',
      baseTargetVirtualPath: '/',
    });

    expect(plan.status).toBe('ready');
    expect(plan.items.map((item) => [item.node.filename, item.targetVirtualPath])).toEqual([
      ['Brief.pdf', '/Projects'],
      ['Logo.png', '/Projects/Art'],
    ]);
    expect(plan.summaryLabel).toBe('Transfer 2 files');
  });

  it('only offers drives that are not the sole source for the selected items', () => {
    const fileRow = rootRows().find((row) => row.name === 'Existing.txt');
    expect(fileRow).toBeDefined();

    const targets = computeTransferTargetAccounts({
      rows: fileRow ? [fileRow] : [],
      nodes,
      accounts,
    });

    expect(targets.map((account) => account.accountId)).toEqual(['drive-a']);
  });
});

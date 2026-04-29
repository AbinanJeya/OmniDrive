import { describe, expect, it } from 'vitest';
import type { AccountState, UnifiedNode } from './types';
import { computeBrowseRows, computeScopeNodes, scopeStorageKey } from './browseModel';

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
    totalBytes: 120,
    usedBytes: 40,
    freeBytes: 80,
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
    id: 'drive-b:folder-projects',
    googleId: 'folder-projects-b',
    accountId: 'drive-b',
    filename: 'Projects',
    isFolder: true,
    sizeBytes: 0,
    virtualPath: '/Projects',
    mimeType: 'application/vnd.google-apps.folder',
    fileCategory: 'folders',
    isPreviewable: false,
  },
  {
    id: 'drive-a:file-plan',
    googleId: 'file-plan',
    accountId: 'drive-a',
    filename: 'Plan.pdf',
    isFolder: false,
    sizeBytes: 1024,
    virtualPath: '/Projects/Plan.pdf',
    mimeType: 'application/pdf',
    modifiedTime: '2026-04-18T12:00:00Z',
    fileCategory: 'pdfs',
    fileExtension: 'pdf',
    isPreviewable: true,
  },
  {
    id: 'drive-b:file-track',
    googleId: 'file-track',
    accountId: 'drive-b',
    filename: 'Theme.mp3',
    isFolder: false,
    sizeBytes: 2048,
    virtualPath: '/Projects/Theme.mp3',
    mimeType: 'audio/mpeg',
    modifiedTime: '2026-04-17T12:00:00Z',
    fileCategory: 'audio',
    fileExtension: 'mp3',
    isPreviewable: true,
  },
  {
    id: 'drive-a:file-note',
    googleId: 'file-note',
    accountId: 'drive-a',
    filename: 'Meeting Notes.txt',
    isFolder: false,
    sizeBytes: 256,
    virtualPath: '/Meeting Notes.txt',
    mimeType: 'text/plain',
    modifiedTime: '2026-04-16T12:00:00Z',
    fileCategory: 'text',
    fileExtension: 'txt',
    isPreviewable: true,
  },
];

describe('browseModel', () => {
  it('computes stable storage keys for per-scope preferences', () => {
    expect(scopeStorageKey({ kind: 'all' })).toBe('all');
    expect(scopeStorageKey({ kind: 'account', accountId: 'drive-a' })).toBe('account:drive-a');
  });

  it('filters nodes for account scopes without losing the separate category lens', () => {
    expect(
      computeScopeNodes(nodes, { kind: 'account', accountId: 'drive-b' }).map((node) => node.id),
    ).toEqual(['drive-b:folder-projects', 'drive-b:file-track']);
  });

  it('returns current-folder rows with folders first and merged directory entries', () => {
    const rows = computeBrowseRows({
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
      sort: {
        field: 'name',
        direction: 'asc',
      },
    });

    expect(rows.map((row) => row.name)).toEqual(['Projects', 'Meeting Notes.txt']);
    expect(rows[0]?.accountLabels).toEqual(['A', 'B']);
  });

  it('searches across the current section when a query is present', () => {
    const rows = computeBrowseRows({
      nodes,
      accounts,
      scope: { kind: 'all' },
      category: 'all',
      folderPath: '/',
      filters: {
        entryKind: 'files',
        category: 'all',
        sourceAccountId: 'all',
        searchQuery: 'theme',
      },
      sort: {
        field: 'modifiedTime',
        direction: 'desc',
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Theme.mp3');
    expect(rows[0]?.virtualPath).toBe('/Projects/Theme.mp3');
  });

  it('keeps category filtering inside the selected drive scope', () => {
    const rows = computeBrowseRows({
      nodes,
      accounts,
      scope: { kind: 'account', accountId: 'drive-a' },
      category: 'pdfs',
      folderPath: '/',
      filters: {
        entryKind: 'files',
        category: 'all',
        sourceAccountId: 'all',
        searchQuery: '',
      },
      sort: {
        field: 'name',
        direction: 'asc',
      },
    });

    expect(rows.map((row) => row.name)).toEqual(['Plan.pdf']);
    expect(rows[0]?.accountLabels).toEqual(['A']);
  });

  it('keeps file metadata on rows so different browse views can share one model', () => {
    const rows = computeBrowseRows({
      nodes,
      accounts,
      scope: { kind: 'all' },
      category: 'all',
      folderPath: '/Projects',
      filters: {
        entryKind: 'files',
        category: 'all',
        sourceAccountId: 'all',
        searchQuery: '',
      },
      sort: {
        field: 'name',
        direction: 'asc',
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'Plan.pdf',
      mimeType: 'application/pdf',
      fileExtension: 'pdf',
      isPreviewable: true,
    });
    expect(rows[1]).toMatchObject({
      name: 'Theme.mp3',
      mimeType: 'audio/mpeg',
      fileExtension: 'mp3',
      isPreviewable: true,
    });
  });
});

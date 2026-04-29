import { describe, expect, it } from 'vitest';
import { GOOGLE_FOLDER_MIME_TYPE } from './normalize';
import type { UnifiedNode } from './types';
import { buildExplorerTree, computeAggregateSizeBytes } from './explorerTree';

const nodes: UnifiedNode[] = [
  {
    id: 'drive-a:projects',
    googleId: 'projects-a',
    accountId: 'drive-a',
    filename: 'Projects',
    isFolder: true,
    sizeBytes: 0,
    virtualPath: '/Projects',
    mimeType: GOOGLE_FOLDER_MIME_TYPE,
    fileCategory: 'folders',
    isPreviewable: false,
  },
  {
    id: 'drive-b:projects',
    googleId: 'projects-b',
    accountId: 'drive-b',
    filename: 'Projects',
    isFolder: true,
    sizeBytes: 0,
    virtualPath: '/Projects',
    mimeType: GOOGLE_FOLDER_MIME_TYPE,
    fileCategory: 'folders',
    isPreviewable: false,
  },
  {
    id: 'drive-a:roadmap',
    googleId: 'roadmap-a',
    accountId: 'drive-a',
    filename: 'Roadmap.pdf',
    isFolder: false,
    sizeBytes: 1024,
    virtualPath: '/Projects/Roadmap.pdf',
    mimeType: 'application/pdf',
    fileCategory: 'pdfs',
    fileExtension: 'pdf',
    isPreviewable: true,
  },
  {
    id: 'drive-b:roadmap',
    googleId: 'roadmap-b',
    accountId: 'drive-b',
    filename: 'Roadmap.pdf',
    isFolder: false,
    sizeBytes: 2048,
    virtualPath: '/Projects/Roadmap.pdf',
    mimeType: 'application/pdf',
    fileCategory: 'pdfs',
    fileExtension: 'pdf',
    isPreviewable: true,
  },
];

describe('buildExplorerTree', () => {
  it('merges same-path folders across accounts while preserving both physical backings', () => {
    const tree = buildExplorerTree(nodes);
    const projectsEntry = tree.children[0];

    expect(projectsEntry?.kind).toBe('directory');
    if (!projectsEntry || projectsEntry.kind !== 'directory') {
      throw new Error('Expected a directory entry for /Projects');
    }

    expect(projectsEntry.virtualPath).toBe('/Projects');
    expect(projectsEntry.backingFolders.map((folder) => folder.accountId)).toEqual([
      'drive-a',
      'drive-b',
    ]);
  });

  it('keeps duplicate same-path files as separate leaves instead of collapsing them', () => {
    const tree = buildExplorerTree(nodes);
    const projectsEntry = tree.children[0];

    if (!projectsEntry || projectsEntry.kind !== 'directory') {
      throw new Error('Expected a directory entry for /Projects');
    }

    expect(projectsEntry.children).toHaveLength(2);
    expect(projectsEntry.children.every((child) => child.kind === 'file')).toBe(true);
    expect(projectsEntry.children.map((child) => child.id)).toEqual([
      'drive-a:roadmap',
      'drive-b:roadmap',
    ]);
    expect(computeAggregateSizeBytes(projectsEntry)).toBe(3072);
  });
});

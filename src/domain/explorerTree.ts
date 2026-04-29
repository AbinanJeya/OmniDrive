import type { UnifiedNode } from './types';

export interface VirtualDirectoryEntry {
  kind: 'directory';
  id: string;
  name: string;
  virtualPath: string;
  backingFolders: UnifiedNode[];
  children: VirtualExplorerEntry[];
}

export interface VirtualFileEntry {
  kind: 'file';
  id: string;
  name: string;
  virtualPath: string;
  node: UnifiedNode;
}

export type VirtualExplorerEntry = VirtualDirectoryEntry | VirtualFileEntry;

function sanitizePathSegment(value: string): string {
  const cleaned = value.trim().replaceAll('/', '_');
  return cleaned.length > 0 ? cleaned : 'Untitled';
}

export function getParentVirtualPath(virtualPath: string): string | null {
  if (virtualPath === '/') {
    return null;
  }

  const trimmed = virtualPath.endsWith('/') ? virtualPath.slice(0, -1) : virtualPath;
  const lastSlash = trimmed.lastIndexOf('/');

  if (lastSlash <= 0) {
    return '/';
  }

  return trimmed.slice(0, lastSlash);
}

function segmentNameFromPath(virtualPath: string): string {
  if (virtualPath === '/') {
    return 'OmniDrive';
  }

  const trimmed = virtualPath.endsWith('/') ? virtualPath.slice(0, -1) : virtualPath;
  const lastSlash = trimmed.lastIndexOf('/');
  return sanitizePathSegment(trimmed.slice(lastSlash + 1));
}

function createDirectory(virtualPath: string): VirtualDirectoryEntry {
  return {
    kind: 'directory',
    id: `dir:${virtualPath}`,
    name: segmentNameFromPath(virtualPath),
    virtualPath,
    backingFolders: [],
    children: [],
  };
}

function sortEntries(entries: VirtualExplorerEntry[]): VirtualExplorerEntry[] {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1;
    }

    const nameComparison = left.name.localeCompare(right.name);
    if (nameComparison !== 0) {
      return nameComparison;
    }

    return left.id.localeCompare(right.id);
  });
}

export function buildExplorerTree(nodes: UnifiedNode[]): VirtualDirectoryEntry {
  const root = createDirectory('/');
  const directoriesByPath = new Map<string, VirtualDirectoryEntry>([['/', root]]);

  const ensureDirectory = (virtualPath: string): VirtualDirectoryEntry => {
    const existing = directoriesByPath.get(virtualPath);
    if (existing) {
      return existing;
    }

    const directory = createDirectory(virtualPath);
    const parentPath = getParentVirtualPath(virtualPath) ?? '/';
    const parentDirectory = ensureDirectory(parentPath);
    parentDirectory.children.push(directory);
    directoriesByPath.set(virtualPath, directory);
    return directory;
  };

  for (const node of [...nodes].sort((left, right) => left.virtualPath.localeCompare(right.virtualPath))) {
    if (node.isFolder) {
      const directory = ensureDirectory(node.virtualPath);
      directory.backingFolders.push(node);
      continue;
    }

    const parentPath = getParentVirtualPath(node.virtualPath) ?? '/';
    const parentDirectory = ensureDirectory(parentPath);
    parentDirectory.children.push({
      kind: 'file',
      id: node.id,
      name: node.filename,
      virtualPath: node.virtualPath,
      node,
    });
  }

  const normalize = (directory: VirtualDirectoryEntry): VirtualDirectoryEntry => ({
    ...directory,
    backingFolders: [...directory.backingFolders].sort((left, right) =>
      left.accountId.localeCompare(right.accountId),
    ),
    children: sortEntries(
      directory.children.map((child) =>
        child.kind === 'directory' ? normalize(child) : child,
      ),
    ),
  });

  return normalize(root);
}

export function computeAggregateSizeBytes(entry: VirtualExplorerEntry): number {
  if (entry.kind === 'file') {
    return entry.node.sizeBytes;
  }

  return entry.children.reduce((sum, child) => sum + computeAggregateSizeBytes(child), 0);
}

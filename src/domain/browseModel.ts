import {
  buildExplorerTree,
  computeAggregateSizeBytes,
  type VirtualDirectoryEntry,
  type VirtualExplorerEntry,
} from './explorerTree';
import type {
  AccountState,
  BrowseCategory,
  BrowseScope,
  FilterModel,
  FileCategory,
  SortModel,
  UnifiedNode,
} from './types';

export interface BrowseRow {
  id: string;
  entry: VirtualExplorerEntry;
  name: string;
  virtualPath: string;
  kind: 'directory' | 'file';
  fileCategory: FileCategory;
  sizeBytes: number;
  modifiedTime?: string;
  sourceAccountIds: string[];
  accountLabels: string[];
  typeLabel: string;
  mimeType: string;
  fileExtension?: string;
  isPreviewable: boolean;
}

export interface ComputeBrowseRowsOptions {
  nodes: UnifiedNode[];
  accounts: AccountState[];
  scope: BrowseScope;
  category: BrowseCategory;
  folderPath: string;
  filters: FilterModel;
  sort: SortModel;
}

export function scopeStorageKey(scope: BrowseScope): string {
  switch (scope.kind) {
    case 'account':
      return `account:${scope.accountId}`;
    default:
      return 'all';
  }
}

export function computeScopeNodes(
  nodes: UnifiedNode[],
  scope: BrowseScope,
): UnifiedNode[] {
  switch (scope.kind) {
    case 'account':
      return nodes.filter((node) => node.accountId === scope.accountId);
    default:
      return nodes;
  }
}

export function computeBrowseRows({
  nodes,
  accounts,
  scope,
  category,
  folderPath,
  filters,
  sort,
}: ComputeBrowseRowsOptions): BrowseRow[] {
  const scopedNodes = computeScopeNodes(nodes, scope);
  const effectiveFilters: FilterModel = {
    ...filters,
    category: category === 'all' ? filters.category : 'all',
    sourceAccountId: scope.kind === 'account' ? 'all' : filters.sourceAccountId,
  };
  const categoryNodes =
    category === 'all'
      ? scopedNodes
      : scopedNodes.filter((node) => node.fileCategory === category);
  const root = buildExplorerTree(categoryNodes);
  const accountLabelById = new Map(accounts.map((account) => [account.accountId, account.label]));

  const baseEntries =
    category !== 'all'
      ? collectAllEntries(root).filter((entry) => entry.kind === 'file')
      : filters.searchQuery.trim().length > 0
      ? collectAllEntries(root)
      : findDirectoryByPath(root, folderPath)?.children ?? [];

  const rows = baseEntries
    .map((entry) => toBrowseRow(entry, accountLabelById))
    .filter((row) => matchesFilters(row, effectiveFilters))
    .sort((left, right) => compareRows(left, right, sort));

  return rows;
}

function toBrowseRow(
  entry: VirtualExplorerEntry,
  accountLabelById: Map<string, string>,
): BrowseRow {
  if (entry.kind === 'directory') {
    const labels = uniqueLabels(
      entry.backingFolders.map(
        (folder) => accountLabelById.get(folder.accountId) ?? folder.accountId,
      ),
    );
    return {
      id: entry.id,
      entry,
      name: entry.name,
      virtualPath: entry.virtualPath,
      kind: 'directory',
      fileCategory: 'folders',
      sizeBytes: computeAggregateSizeBytes(entry),
      modifiedTime: latestModifiedTime(entry.backingFolders.map((folder) => folder.modifiedTime)),
      sourceAccountIds: entry.backingFolders.map((folder) => folder.accountId),
      accountLabels: labels,
      typeLabel: 'Folder',
      mimeType: entry.backingFolders[0]?.mimeType ?? 'application/vnd.google-apps.folder',
      fileExtension: undefined,
      isPreviewable: false,
    };
  }

  return {
    id: entry.id,
    entry,
    name: entry.name,
    virtualPath: entry.virtualPath,
    kind: 'file',
    fileCategory: entry.node.fileCategory,
    sizeBytes: entry.node.sizeBytes,
    modifiedTime: entry.node.modifiedTime,
    sourceAccountIds: [entry.node.accountId],
    accountLabels: [
      accountLabelById.get(entry.node.accountId) ?? entry.node.accountId,
    ],
    typeLabel: typeLabelForCategory(entry.node.fileCategory),
    mimeType: entry.node.mimeType,
    fileExtension: entry.node.fileExtension,
    isPreviewable: entry.node.isPreviewable,
  };
}

function findDirectoryByPath(
  directory: VirtualDirectoryEntry,
  path: string,
): VirtualDirectoryEntry | undefined {
  if (directory.virtualPath === path) {
    return directory;
  }

  for (const child of directory.children) {
    if (child.kind !== 'directory') {
      continue;
    }

    const match = findDirectoryByPath(child, path);
    if (match) {
      return match;
    }
  }

  return undefined;
}

function collectAllEntries(directory: VirtualDirectoryEntry): VirtualExplorerEntry[] {
  const entries: VirtualExplorerEntry[] = [];

  for (const child of directory.children) {
    entries.push(child);
    if (child.kind === 'directory') {
      entries.push(...collectAllEntries(child));
    }
  }

  return entries;
}

function latestModifiedTime(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0];
}

function uniqueLabels(labels: string[]): string[] {
  return [...new Set(labels)].sort((left, right) => left.localeCompare(right));
}

function matchesFilters(row: BrowseRow, filters: FilterModel): boolean {
  if (filters.entryKind === 'folders' && row.kind !== 'directory') {
    return false;
  }

  if (filters.entryKind === 'files' && row.kind !== 'file') {
    return false;
  }

  if (filters.category !== 'all' && row.fileCategory !== filters.category) {
    return false;
  }

  if (
    filters.sourceAccountId !== 'all' &&
    !row.sourceAccountIds.some((accountId) => accountId === filters.sourceAccountId)
  ) {
    return false;
  }

  if (filters.searchQuery.trim().length === 0) {
    return true;
  }

  const needle = filters.searchQuery.trim().toLowerCase();
  return (
    row.name.toLowerCase().includes(needle) ||
    row.virtualPath.toLowerCase().includes(needle) ||
    row.fileCategory.toLowerCase().includes(needle) ||
    row.typeLabel.toLowerCase().includes(needle)
  );
}

function compareRows(left: BrowseRow, right: BrowseRow, sort: SortModel): number {
  if (left.kind !== right.kind) {
    return left.kind === 'directory' ? -1 : 1;
  }

  let comparison = 0;
  switch (sort.field) {
    case 'modifiedTime':
      comparison = (left.modifiedTime ?? '').localeCompare(right.modifiedTime ?? '');
      break;
    case 'sizeBytes':
      comparison = left.sizeBytes - right.sizeBytes;
      break;
    case 'fileCategory':
      comparison = left.fileCategory.localeCompare(right.fileCategory);
      break;
    case 'name':
    default:
      comparison = left.name.localeCompare(right.name);
      break;
  }

  if (comparison === 0) {
    comparison = left.virtualPath.localeCompare(right.virtualPath);
  }

  return sort.direction === 'asc' ? comparison : comparison * -1;
}

function typeLabelForCategory(category: FileCategory): string {
  switch (category) {
    case 'documents':
      return 'Document';
    case 'spreadsheets':
      return 'Spreadsheet';
    case 'pdfs':
      return 'PDF';
    case 'images':
      return 'Image';
    case 'videos':
      return 'Video';
    case 'audio':
      return 'Audio';
    case 'text':
      return 'Text';
    case 'archives':
      return 'Archive';
    case 'folders':
      return 'Folder';
    default:
      return 'File';
  }
}

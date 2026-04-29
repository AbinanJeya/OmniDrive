import type { AccountState, DuplicateGroup, StorageInsight, UnifiedNode } from './types';

interface GetStorageInsightsOptions {
  accounts: AccountState[];
  nodes: UnifiedNode[];
  now?: Date;
}

const OLD_FILE_AGE_DAYS = 365 * 3;
const LOW_SPACE_PERCENT = 0.1;

export function findDuplicateGroups(nodes: UnifiedNode[]): DuplicateGroup[] {
  const files = nodes.filter((node) => !node.isFolder && node.sizeBytes > 0);
  const checksumGroups = groupBy(
    files.filter((node) => Boolean(node.checksum)),
    (node) => `checksum:${node.checksum}`,
  );
  const checksumDuplicateIds = new Set<string>();
  const duplicates: DuplicateGroup[] = [];

  for (const [key, group] of checksumGroups) {
    if (group.length < 2) {
      continue;
    }

    for (const node of group) {
      checksumDuplicateIds.add(node.id);
    }
    duplicates.push(toDuplicateGroup(key, 'checksum', group));
  }

  const nameAndSizeGroups = groupBy(
    files.filter((node) => !checksumDuplicateIds.has(node.id)),
    (node) => `name-size:${node.filename.toLowerCase()}:${node.sizeBytes}`,
  );

  for (const [key, group] of nameAndSizeGroups) {
    if (group.length < 2) {
      continue;
    }

    duplicates.push(toDuplicateGroup(key, 'nameAndSize', group));
  }

  return duplicates.sort((left, right) => right.reclaimableBytes - left.reclaimableBytes);
}

export function getStorageInsights({
  accounts,
  nodes,
  now = new Date(),
}: GetStorageInsightsOptions): StorageInsight[] {
  const insights: StorageInsight[] = [];
  const duplicateGroups = findDuplicateGroups(nodes);
  const visibleCapacity = accounts.reduce((sum, account) => sum + account.totalBytes, 0);
  const largeFileThreshold =
    visibleCapacity > 10 * 1024 * 1024
      ? Math.max(500 * 1024 * 1024, Math.floor(visibleCapacity * 0.25))
      : Math.floor(visibleCapacity * 0.25);
  const largeFiles = nodes
    .filter((node) => !node.isFolder && node.sizeBytes >= largeFileThreshold)
    .sort((left, right) => right.sizeBytes - left.sizeBytes)
    .slice(0, 25);
  const oldFiles = nodes
    .filter((node) => !node.isFolder && isOlderThan(node.modifiedTime, now, OLD_FILE_AGE_DAYS))
    .sort((left, right) => right.sizeBytes - left.sizeBytes)
    .slice(0, 25);

  for (const account of accounts) {
    if (!account.isConnected || account.totalBytes <= 0) {
      continue;
    }

    const freePercent = account.freeBytes / account.totalBytes;
    if (freePercent <= LOW_SPACE_PERCENT) {
      insights.push({
        id: `low-space:${account.accountId}`,
        kind: 'lowSpace',
        title: `Drive ${account.label} is almost full`,
        description: `${formatPercent(freePercent)} free on ${account.displayName}.`,
        severity: freePercent <= 0.075 ? 'critical' : 'warning',
        accountId: account.accountId,
        nodeIds: [],
        reclaimableBytes: 0,
      });
    }

    if (account.sourceKind === 'photos') {
      insights.push({
        id: `photos-limit:${account.accountId}`,
        kind: 'photosLimit',
        title: `Photos ${account.label} uses Picker batches`,
        description: 'Google Photos access is limited to user-picked batches of up to 2000 items.',
        severity: 'info',
        accountId: account.accountId,
        nodeIds: [],
        reclaimableBytes: 0,
      });
    }
  }

  if (largeFiles.length > 0) {
    insights.push({
      id: 'large-files',
      kind: 'largeFiles',
      title: 'Large files',
      description: `${largeFiles.length} large files are using prominent storage space.`,
      severity: 'info',
      nodeIds: largeFiles.map((node) => node.id),
      reclaimableBytes: sumSizes(largeFiles),
    });
  }

  if (oldFiles.length > 0) {
    insights.push({
      id: 'old-files',
      kind: 'oldFiles',
      title: 'Old files',
      description: `${oldFiles.length} files have not changed in more than three years.`,
      severity: 'info',
      nodeIds: oldFiles.map((node) => node.id),
      reclaimableBytes: sumSizes(oldFiles),
    });
  }

  if (duplicateGroups.length > 0) {
    insights.push({
      id: 'duplicates',
      kind: 'duplicates',
      title: 'Possible duplicates',
      description: `${duplicateGroups.length} duplicate groups can be reviewed safely.`,
      severity: 'warning',
      nodeIds: duplicateGroups.flatMap((group) => group.nodes.map((node) => node.id)),
      reclaimableBytes: duplicateGroups.reduce((sum, group) => sum + group.reclaimableBytes, 0),
    });
  }

  return insights;
}

function toDuplicateGroup(
  key: string,
  reason: DuplicateGroup['reason'],
  nodes: UnifiedNode[],
): DuplicateGroup {
  const sortedNodes = [...nodes].sort((left, right) => left.virtualPath.localeCompare(right.virtualPath));
  return {
    id: key,
    reason,
    nodes: sortedNodes,
    reclaimableBytes: sumSizes(sortedNodes.slice(1)),
  };
}

function groupBy<T>(items: T[], keyForItem: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyForItem(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function sumSizes(nodes: UnifiedNode[]): number {
  return nodes.reduce((sum, node) => sum + node.sizeBytes, 0);
}

function isOlderThan(value: string | undefined, now: Date, days: number): boolean {
  if (!value) {
    return false;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }

  const ageMs = now.getTime() - parsed.getTime();
  return ageMs > days * 24 * 60 * 60 * 1000;
}

function formatPercent(value: number): string {
  return `${Math.max(0, value * 100).toFixed(1)}%`;
}

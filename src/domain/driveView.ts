import type { AccountState, UnifiedNode } from './types';

export type DriveViewScope =
  | { kind: 'all' }
  | { kind: 'account'; accountId: string };

export interface StorageSummary {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePercent: number;
}

export interface BreadcrumbSegment {
  id: string;
  label: string;
}

export function filterAccountsForScope(
  accounts: AccountState[],
  scope: DriveViewScope,
): AccountState[] {
  return scope.kind === 'all'
    ? accounts
    : accounts.filter((account) => account.accountId === scope.accountId);
}

export function filterNodesForScope(nodes: UnifiedNode[], scope: DriveViewScope): UnifiedNode[] {
  return scope.kind === 'all'
    ? nodes
    : nodes.filter((node) => node.accountId === scope.accountId);
}

export function computeStorageSummary(
  accounts: AccountState[],
  scope: DriveViewScope,
): StorageSummary {
  const visibleAccounts = filterAccountsForScope(
    accounts.filter((account) => account.isConnected),
    scope,
  );
  const storageBuckets = buildStorageBuckets(visibleAccounts);
  const totalBytes = storageBuckets.reduce((sum, bucket) => sum + bucket.totalBytes, 0);
  const usedBytes = storageBuckets.reduce((sum, bucket) => sum + bucket.usedBytes, 0);
  const freeBytes = storageBuckets.reduce((sum, bucket) => sum + bucket.freeBytes, 0);
  const usagePercent = totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0;

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usagePercent,
  };
}

export function buildBreadcrumbSegments(
  accounts: AccountState[],
  scope: DriveViewScope,
  virtualPath: string,
): BreadcrumbSegment[] {
  const rootLabel =
    scope.kind === 'all'
      ? 'All Drives'
      : `Drive ${accounts.find((account) => account.accountId === scope.accountId)?.label ?? scope.accountId}`;

  const segments: BreadcrumbSegment[] = [
    {
      id: 'root',
      label: rootLabel,
    },
  ];

  const normalizedPath = normalizeVirtualPath(virtualPath);
  if (normalizedPath === '/') {
    return segments;
  }

  const parts = normalizedPath.slice(1).split('/');
  for (const [index, part] of parts.entries()) {
    segments.push({
      id: `${index}:${part}`,
      label: part,
    });
  }

  return segments;
}

function normalizeVirtualPath(virtualPath: string): string {
  if (!virtualPath.trim()) {
    return '/';
  }

  const withSlashes = virtualPath.replaceAll('\\', '/');
  if (withSlashes === '/') {
    return '/';
  }

  return withSlashes.endsWith('/') ? withSlashes.slice(0, -1) : withSlashes;
}

function normalizedTotalBytes(account: AccountState): number {
  if (account.totalBytes > 0) {
    return account.totalBytes;
  }

  return Math.max(0, account.usedBytes) + Math.max(0, account.freeBytes);
}

function normalizedFreeBytes(account: AccountState): number {
  if (account.freeBytes > 0) {
    return account.freeBytes;
  }

  return Math.max(0, normalizedTotalBytes(account) - Math.max(0, account.usedBytes));
}

function buildStorageBuckets(accounts: AccountState[]): StorageSummary[] {
  const buckets: StorageSummary[] = [];
  const largeDriveGroups = new Map<number, AccountState[]>();

  for (const account of accounts) {
    const totalBytes = normalizedTotalBytes(account);
    if (account.sourceKind === 'drive' && totalBytes >= 1024 ** 4) {
      const group = largeDriveGroups.get(totalBytes) ?? [];
      group.push(account);
      largeDriveGroups.set(totalBytes, group);
      continue;
    }

    buckets.push(storageBucketFromAccounts([account]));
  }

  for (const group of largeDriveGroups.values()) {
    buckets.push(group.length > 1 ? sharedQuotaBucketFromAccounts(group) : storageBucketFromAccounts(group));
  }

  return buckets;
}

function storageBucketFromAccounts(accounts: AccountState[]): StorageSummary {
  const totalBytes = accounts.reduce((sum, account) => sum + normalizedTotalBytes(account), 0);
  const usedBytes = accounts.reduce((sum, account) => sum + Math.max(0, account.usedBytes), 0);
  const freeBytes = accounts.reduce((sum, account) => sum + normalizedFreeBytes(account), 0);

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usagePercent: totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0,
  };
}

function sharedQuotaBucketFromAccounts(accounts: AccountState[]): StorageSummary {
  const totalBytes = Math.max(...accounts.map((account) => normalizedTotalBytes(account)));
  const usedBytes = Math.max(...accounts.map((account) => Math.max(0, account.usedBytes)));
  const freeBytes = Math.max(0, totalBytes - usedBytes);

  return {
    totalBytes,
    usedBytes,
    freeBytes,
    usagePercent: totalBytes > 0 ? Math.min(100, (usedBytes / totalBytes) * 100) : 0,
  };
}

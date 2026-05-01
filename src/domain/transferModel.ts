import type { BrowseRow } from './browseModel';
import type { AccountState, UnifiedNode } from './types';

export interface PlannedTransferItem {
  node: UnifiedNode;
  targetVirtualPath: string;
}

export type TransferPlanStatus = 'ready' | 'empty' | 'unsupported';

export interface TransferPlan {
  status: TransferPlanStatus;
  items: PlannedTransferItem[];
  summaryLabel: string;
  message?: string;
}

export interface PlanDriveTransferItemsInput {
  rows: BrowseRow[];
  nodes: UnifiedNode[];
  accounts: AccountState[];
  targetAccountId: string;
  baseTargetVirtualPath: string;
}

export interface ComputeTransferTargetAccountsInput {
  rows: BrowseRow[];
  nodes: UnifiedNode[];
  accounts: AccountState[];
}

export function computeTransferTargetAccounts({
  rows,
  nodes,
  accounts,
}: ComputeTransferTargetAccountsInput): AccountState[] {
  return accounts.filter((account) => {
    if (account.sourceKind !== 'drive' || !account.isConnected) {
      return false;
    }

    const plan = planDriveTransferItems({
      rows,
      nodes,
      accounts,
      targetAccountId: account.accountId,
      baseTargetVirtualPath: '/',
    });
    return plan.status === 'ready';
  });
}

export function planDriveTransferItems({
  rows,
  nodes,
  accounts,
  targetAccountId,
  baseTargetVirtualPath,
}: PlanDriveTransferItemsInput): TransferPlan {
  const driveAccountIds = new Set(
    accounts
      .filter((account) => account.sourceKind === 'drive' && account.isConnected)
      .map((account) => account.accountId),
  );
  const items = new Map<string, PlannedTransferItem>();
  const unsupportedRows = new Set<string>();

  for (const row of rows) {
    if (row.entry.kind === 'file') {
      const node = row.entry.node;
      if (!isTransferableDriveFile(node, driveAccountIds)) {
        unsupportedRows.add(row.name);
        continue;
      }

      addTransferItem(items, node, targetAccountId, baseTargetVirtualPath);
      continue;
    }

    const descendantFiles = nodes
      .filter((node) => {
        if (!isTransferableDriveFile(node, driveAccountIds)) {
          return false;
        }

        if (!row.sourceAccountIds.includes(node.accountId)) {
          return false;
        }

        return isInsideVirtualFolder(node.virtualPath, row.virtualPath);
      })
      .sort(compareVirtualPathsForTransfer);

    if (descendantFiles.length === 0) {
      unsupportedRows.add(row.name);
      continue;
    }

    for (const node of descendantFiles) {
      addTransferItem(items, node, targetAccountId, parentVirtualPath(node.virtualPath));
    }
  }

  const plannedItems = [...items.values()].filter(
    (item) => item.node.accountId !== targetAccountId,
  );
  if (plannedItems.length > 0) {
    return {
      status: 'ready',
      items: plannedItems,
      summaryLabel:
        plannedItems.length === 1
          ? `Transfer ${plannedItems[0]?.node.filename ?? 'file'}`
          : `Transfer ${plannedItems.length} files`,
    };
  }

  if (unsupportedRows.size > 0) {
    return {
      status: 'unsupported',
      items: [],
      summaryLabel: 'Transfer files',
      message:
        'Transfer only supports connected Google Drive files or folders that contain Drive files.',
    };
  }

  return {
    status: 'empty',
    items: [],
    summaryLabel: 'Transfer files',
    message: 'Choose files or folders from another connected Google Drive account.',
  };
}

function isTransferableDriveFile(node: UnifiedNode, driveAccountIds: Set<string>): boolean {
  return !node.isFolder && driveAccountIds.has(node.accountId);
}

function isInsideVirtualFolder(virtualPath: string, folderPath: string): boolean {
  const normalizedFolder = normalizeVirtualPath(folderPath);
  if (normalizedFolder === '/') {
    return virtualPath !== '/';
  }

  return virtualPath.startsWith(`${normalizedFolder}/`);
}

function parentVirtualPath(virtualPath: string): string {
  const normalized = normalizeVirtualPath(virtualPath);
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex <= 0) {
    return '/';
  }

  return normalized.slice(0, slashIndex);
}

function compareVirtualPathsForTransfer(left: UnifiedNode, right: UnifiedNode): number {
  const leftDepth = normalizeVirtualPath(left.virtualPath).split('/').length;
  const rightDepth = normalizeVirtualPath(right.virtualPath).split('/').length;
  if (leftDepth !== rightDepth) {
    return leftDepth - rightDepth;
  }

  return left.virtualPath.localeCompare(right.virtualPath);
}

function normalizeVirtualPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') {
    return '/';
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/u, '') || '/';
}

function addTransferItem(
  items: Map<string, PlannedTransferItem>,
  node: UnifiedNode,
  targetAccountId: string,
  targetVirtualPath: string,
) {
  if (node.accountId === targetAccountId) {
    return;
  }

  const normalizedTarget = normalizeVirtualPath(targetVirtualPath);
  items.set(`${node.accountId}:${node.googleId}:${normalizedTarget}`, {
    node,
    targetVirtualPath: normalizedTarget,
  });
}

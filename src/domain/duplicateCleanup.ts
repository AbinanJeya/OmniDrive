import type { AccountState, LocalIndexDuplicateGroup, UnifiedNode } from './types';

export interface DuplicateReviewGroup {
  id: string;
  reason: LocalIndexDuplicateGroup['reason'];
  reclaimableBytes: number;
  nodes: UnifiedNode[];
  keepNode: UnifiedNode;
  duplicateNodes: UnifiedNode[];
}

export function resolveDuplicateReviewGroups(
  groups: LocalIndexDuplicateGroup[],
  nodes: UnifiedNode[],
): DuplicateReviewGroup[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  return groups
    .map((group) => {
      const resolvedNodes = group.nodeIds
        .map((nodeId) => nodeById.get(nodeId))
        .filter((node): node is UnifiedNode => Boolean(node))
        .sort((left, right) => left.virtualPath.localeCompare(right.virtualPath));

      if (resolvedNodes.length < 2) {
        return null;
      }

      return {
        id: group.id,
        reason: group.reason,
        reclaimableBytes: group.reclaimableBytes,
        nodes: resolvedNodes,
        keepNode: resolvedNodes[0],
        duplicateNodes: resolvedNodes.slice(1),
      } satisfies DuplicateReviewGroup;
    })
    .filter((group): group is DuplicateReviewGroup => Boolean(group))
    .sort((left, right) => right.reclaimableBytes - left.reclaimableBytes);
}

export function totalReclaimableBytes(groups: DuplicateReviewGroup[]): number {
  return groups.reduce((sum, group) => sum + group.reclaimableBytes, 0);
}

export function duplicateSelectionBytes(nodes: UnifiedNode[]): number {
  return nodes.reduce((sum, node) => sum + node.sizeBytes, 0);
}

export function duplicateSelectionAccountLabels(
  nodes: UnifiedNode[],
  accounts: AccountState[],
): string[] {
  const labelByAccountId = new Map(accounts.map((account) => [account.accountId, account.label]));
  return [...new Set(nodes.map((node) => labelByAccountId.get(node.accountId) ?? node.accountId))];
}

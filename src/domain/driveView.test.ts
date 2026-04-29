import { describe, expect, it } from 'vitest';
import type { AccountState, UnifiedNode } from './types';
import {
  buildBreadcrumbSegments,
  computeStorageSummary,
  filterAccountsForScope,
  filterNodesForScope,
  type DriveViewScope,
} from './driveView';

const accounts: AccountState[] = [
  {
    accountId: 'drive-a',
    label: 'A',
    displayName: 'Alpha Drive',
    email: 'a@example.com',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 1000,
    usedBytes: 250,
    freeBytes: 750,
  },
  {
    accountId: 'drive-b',
    label: 'B',
    displayName: 'Beta Drive',
    email: 'b@example.com',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 2000,
    usedBytes: 500,
    freeBytes: 1500,
  },
];

const nodes: UnifiedNode[] = [
  {
    id: 'drive-a:file-1',
    googleId: 'file-1',
    accountId: 'drive-a',
    filename: 'Budget.xlsx',
    isFolder: false,
    sizeBytes: 120,
    virtualPath: '/Finance/Budget.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileCategory: 'spreadsheets',
    fileExtension: 'xlsx',
    isPreviewable: true,
  },
  {
    id: 'drive-b:file-2',
    googleId: 'file-2',
    accountId: 'drive-b',
    filename: 'Hero.jpg',
    isFolder: false,
    sizeBytes: 220,
    virtualPath: '/Assets/Hero.jpg',
    mimeType: 'image/jpeg',
    fileCategory: 'images',
    fileExtension: 'jpg',
    isPreviewable: true,
  },
];

describe('driveView selectors', () => {
  it('filters accounts and nodes for a single drive scope', () => {
    const scope: DriveViewScope = { kind: 'account', accountId: 'drive-b' };

    expect(filterAccountsForScope(accounts, scope).map((account) => account.accountId)).toEqual([
      'drive-b',
    ]);
    expect(filterNodesForScope(nodes, scope).map((node) => node.accountId)).toEqual(['drive-b']);
  });

  it('computes aggregate storage for the all-drives scope', () => {
    const summary = computeStorageSummary(accounts, { kind: 'all' });

    expect(summary.totalBytes).toBe(3000);
    expect(summary.usedBytes).toBe(750);
    expect(summary.freeBytes).toBe(2250);
    expect(summary.usagePercent).toBe(25);
  });

  it('deduplicates likely shared Google family storage quotas', () => {
    const familyPlanBytes = 5 * 1024 ** 4;
    const summary = computeStorageSummary(
      [
        {
          accountId: 'drive-family-a',
          label: 'A',
          displayName: 'Family A',
          email: 'a@example.com',
          sourceKind: 'drive',
          isConnected: true,
          totalBytes: familyPlanBytes,
          usedBytes: 800 * 1024 ** 3,
          freeBytes: familyPlanBytes - 800 * 1024 ** 3,
        },
        {
          accountId: 'drive-family-b',
          label: 'B',
          displayName: 'Family B',
          email: 'b@example.com',
          sourceKind: 'drive',
          isConnected: true,
          totalBytes: familyPlanBytes,
          usedBytes: 900 * 1024 ** 3,
          freeBytes: familyPlanBytes - 900 * 1024 ** 3,
        },
      ],
      { kind: 'all' },
    );

    expect(summary.totalBytes).toBe(familyPlanBytes);
    expect(summary.usedBytes).toBe(900 * 1024 ** 3);
    expect(summary.freeBytes).toBe(familyPlanBytes - 900 * 1024 ** 3);
  });

  it('builds breadcrumbs for all drives and account views', () => {
    expect(
      buildBreadcrumbSegments(accounts, { kind: 'all' }, '/Finance/Archive').map(
        (segment) => segment.label,
      ),
    ).toEqual(['All Drives', 'Finance', 'Archive']);

    expect(
      buildBreadcrumbSegments(accounts, { kind: 'account', accountId: 'drive-a' }, '/').map(
        (segment) => segment.label,
      ),
    ).toEqual(['Drive A']);
  });
});

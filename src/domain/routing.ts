import type { AccountState } from './types';

export class InsufficientDriveSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientDriveSpaceError';
  }
}

function assertFiniteNonNegativeNumber(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a finite, non-negative number.`);
  }
}

function usableFreeBytes(account: AccountState): number {
  return account.isConnected ? Math.max(0, account.freeBytes) : 0;
}

export function calculateOptimalDrive(
  fileSize: number,
  connectedAccounts: AccountState[],
): string {
  assertFiniteNonNegativeNumber(fileSize, 'fileSize');

  // Greedy rule: among connected drives that can fit the file, pick the one
  // with the most free space so the upload does not strand larger future files.
  const candidates = connectedAccounts.filter((account) => account.isConnected);

  if (candidates.length === 0) {
    throw new InsufficientDriveSpaceError('No connected drives are available for uploads.');
  }

  const withCapacity = candidates
    .map((account) => ({
      account,
      freeBytes: usableFreeBytes(account),
    }))
    .filter(({ freeBytes }) => freeBytes >= fileSize);

  if (withCapacity.length === 0) {
    const maximumCapacity = candidates.reduce(
      (max, account) => Math.max(max, usableFreeBytes(account)),
      0,
    );

    throw new InsufficientDriveSpaceError(
      `File size ${fileSize} bytes exceeds the maximum continuous free space of any single drive (${maximumCapacity} bytes).`,
    );
  }

  withCapacity.sort((left, right) => {
    if (right.freeBytes !== left.freeBytes) {
      return right.freeBytes - left.freeBytes;
    }

    // Stable tie-breaker keeps routing deterministic across rerenders.
    return left.account.accountId.localeCompare(right.account.accountId);
  });

  return withCapacity[0].account.accountId;
}

import { describe, expect, it } from 'vitest';
import { calculateOptimalDrive, InsufficientDriveSpaceError } from './routing';
import type { AccountState } from './types';

const accounts: AccountState[] = [
  {
    accountId: 'drive-a',
    label: 'A',
    displayName: 'Drive A',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 15,
    usedBytes: 4,
    freeBytes: 11,
  },
  {
    accountId: 'drive-b',
    label: 'B',
    displayName: 'Drive B',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 15,
    usedBytes: 7,
    freeBytes: 8,
  },
  {
    accountId: 'drive-c',
    label: 'C',
    displayName: 'Drive C',
    sourceKind: 'drive',
    isConnected: false,
    totalBytes: 15,
    usedBytes: 1,
    freeBytes: 14,
  },
];

describe('calculateOptimalDrive', () => {
  it('chooses the connected drive with the most free space that can still fit the file', () => {
    expect(calculateOptimalDrive(8, accounts)).toBe('drive-a');
  });

  it('throws when the file does not fit on any connected drive', () => {
    expect(() => calculateOptimalDrive(99, accounts)).toThrow(InsufficientDriveSpaceError);
  });
});

import { describe, expect, it } from 'vitest';
import { GOOGLE_FOLDER_MIME_TYPE, mergeDriveSnapshots } from './normalize';
import type { DriveSnapshot } from './types';

const driveA: DriveSnapshot = {
  account: {
    accountId: 'drive-a',
    label: 'A',
    displayName: 'Drive A',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 15,
    usedBytes: 4,
    freeBytes: 11,
  },
  files: [
    {
      id: 'a-folder-projects',
      name: 'Projects',
      mimeType: GOOGLE_FOLDER_MIME_TYPE,
      parents: [],
    },
    {
      id: 'a-file-roadmap',
      name: 'Roadmap.pdf',
      mimeType: 'application/pdf',
      size: '1024',
      parents: ['a-folder-projects'],
    },
  ],
};

const driveB: DriveSnapshot = {
  account: {
    accountId: 'drive-b',
    label: 'B',
    displayName: 'Drive B',
    sourceKind: 'drive',
    isConnected: true,
    totalBytes: 15,
    usedBytes: 7,
    freeBytes: 8,
  },
  files: [
    {
      id: 'b-file-notes',
      name: 'Notes.txt',
      mimeType: 'text/plain',
      size: '2048',
      parents: [],
    },
  ],
};

describe('normalizeDriveSnapshot', () => {
  it('flattens multiple Drive accounts into a single normalized array', () => {
    const merged = mergeDriveSnapshots(driveA, driveB);

    expect(merged).toHaveLength(3);
    expect(merged[0]?.virtualPath).toBe('/Projects');
    expect(merged[1]?.virtualPath).toBe('/Projects/Roadmap.pdf');
    expect(merged[2]?.accountId).toBe('drive-b');
  });

  it('places Google Photos items into a date-based virtual path tree', () => {
    const photos: DriveSnapshot = {
      account: {
        accountId: 'photos:drive-a@example.com',
        label: 'C',
        displayName: 'Google Photos',
        sourceKind: 'photos',
        isConnected: true,
        totalBytes: 15,
        usedBytes: 5,
        freeBytes: 10,
      },
      files: [
        {
          id: 'photo-1',
          name: 'Sunset.jpg',
          mimeType: 'image/jpeg',
          modifiedTime: '2026-04-19T12:34:56Z',
        },
      ],
    };

    const merged = mergeDriveSnapshots(photos);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.virtualPath).toBe('/Google Photos/2026/04/19/Sunset.jpg');
    expect(merged[0]?.fileCategory).toBe('images');
  });
});

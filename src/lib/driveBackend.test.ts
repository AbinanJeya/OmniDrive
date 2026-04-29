import { describe, expect, it, vi } from 'vitest';
import { GOOGLE_FOLDER_MIME_TYPE } from '../domain/normalize';
import type { DriveSnapshot, PreviewDescriptor } from '../domain/types';
import {
  buildVirtualDriveState,
  cancelDriveJob,
  clearDesktopAppSession,
  connectGooglePhotosAccount,
  getLocalIndex,
  listDriveJobs,
  listDriveRevisions,
  loadVirtualDriveState,
  lookupCachedDriveNodePreview,
  setDesktopAppSession,
  shareDriveNode,
  syncAccountChanges,
  updateDriveJob,
  updateAppSettings,
  transferDriveNodes,
} from './driveBackend';

const liveSnapshots: DriveSnapshot[] = [
  {
    account: {
      accountId: 'drive-a',
      label: 'A',
      displayName: 'Drive A',
      email: 'drive-a@example.com',
      sourceKind: 'drive',
      isConnected: true,
      totalBytes: 15,
      usedBytes: 4,
      freeBytes: 11,
      lastSyncedAt: '2026-04-18T14:00:00.000Z',
    },
    files: [
      {
        id: 'folder-1',
        name: 'Projects',
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        parents: [],
      },
      {
        id: 'file-1',
        name: 'Roadmap.pdf',
        mimeType: 'application/pdf',
        size: '1024',
        parents: ['folder-1'],
      },
    ],
  },
  {
    account: {
      accountId: 'drive-b',
      label: 'B',
      displayName: 'Drive B',
      email: 'drive-b@example.com',
      sourceKind: 'drive',
      isConnected: true,
      totalBytes: 1500,
      usedBytes: 600,
      freeBytes: 900,
      lastSyncedAt: '2026-04-18T14:05:00.000Z',
      loadError: 'Failed to fetch Google Drive file list for drive-b: timeout',
    },
    files: [],
  },
];

describe('buildVirtualDriveState', () => {
  it('normalizes backend snapshots into account state and unified nodes', () => {
    const state = buildVirtualDriveState(liveSnapshots);

    expect(state.accounts).toHaveLength(2);
    expect(state.nodes).toHaveLength(2);
    expect(state.nodes[1]?.virtualPath).toBe('/Projects/Roadmap.pdf');
    expect(state.requiresDesktopShell).toBe(false);
    expect(state.accounts[1]?.loadError).toContain('file list');
    expect(state.accounts[1]?.totalBytes).toBe(1500);
  });
});

describe('loadVirtualDriveState', () => {
  it('returns an empty desktop-only state when Tauri is unavailable', async () => {
    const state = await loadVirtualDriveState({
      isTauriRuntime: false,
      invoke: vi.fn(),
    });

    expect(state.accounts).toEqual([]);
    expect(state.nodes).toEqual([]);
    expect(state.requiresDesktopShell).toBe(true);
  });

  it('invokes the backend command and normalizes the returned snapshots', async () => {
    const invoke = vi.fn().mockResolvedValue(liveSnapshots);

    const state = await loadVirtualDriveState({
      isTauriRuntime: true,
      invoke,
    });

    expect(invoke).toHaveBeenCalledWith('load_drive_snapshots');
    expect(state.accounts[0]?.accountId).toBe('drive-a');
    expect(state.nodes[1]?.virtualPath).toBe('/Projects/Roadmap.pdf');
  });

  it('routes Google Photos connection requests to the dedicated Tauri handler', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);

    await connectGooglePhotosAccount(invoke);

    expect(invoke).toHaveBeenCalledWith('start_google_photos_oauth');
  });

  it('looks up cached preview assets before requesting a full preview', async () => {
    const cachedDescriptor: PreviewDescriptor = {
      kind: 'image',
      filename: 'Hero.png',
      mimeType: 'image/png',
      accountId: 'drive-a',
      googleId: 'file-hero',
      localPath: 'C:\\cache\\hero.png',
    };
    const invoke = vi.fn().mockResolvedValue(cachedDescriptor);

    const descriptor = await lookupCachedDriveNodePreview(
      {
        accountId: 'drive-a',
        googleId: 'file-hero',
        filename: 'Hero.png',
        mimeType: 'image/png',
      },
      invoke,
    );

    expect(invoke).toHaveBeenCalledWith('lookup_cached_drive_node_preview', {
      accountId: 'drive-a',
      googleId: 'file-hero',
      filename: 'Hero.png',
      mimeType: 'image/png',
    });
    expect(descriptor?.localPath).toBe('C:\\cache\\hero.png');
  });

  it('routes batch transfer requests to the backend command', async () => {
    const invoke = vi.fn().mockResolvedValue(2);

    const transferredCount = await transferDriveNodes(
      [
        {
          accountId: 'drive-a',
          googleId: 'file-1',
          filename: 'Roadmap.pdf',
          mimeType: 'application/pdf',
        },
      ],
      'drive-b',
      '/Projects',
      invoke,
    );

    expect(invoke).toHaveBeenCalledWith('transfer_drive_nodes', {
      nodes: [
        {
          accountId: 'drive-a',
          googleId: 'file-1',
          filename: 'Roadmap.pdf',
          mimeType: 'application/pdf',
        },
      ],
      targetAccountId: 'drive-b',
      targetVirtualPath: '/Projects',
    });
    expect(transferredCount).toBe(2);
  });

  it('routes local index and job requests to the backend foundation commands', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        accounts: [],
        nodes: [],
        syncStates: [],
        jobs: [],
        settings: {
          themeMode: 'dark',
          themeVariant: 'classic',
          defaultViewMode: 'list',
          gridCardSize: 220,
          syncIntervalMinutes: 15,
          previewCacheLimitMb: 512,
          notificationsEnabled: true,
          safeTransferEnabled: true,
          hasCompletedFirstRun: false,
        },
        insights: [],
        duplicateGroups: [],
      })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(undefined);

    await getLocalIndex(invoke);
    await listDriveJobs(invoke);
    await updateAppSettings(
      {
        themeMode: 'light',
        themeVariant: 'mono',
        defaultViewMode: 'grid',
        gridCardSize: 260,
        syncIntervalMinutes: 30,
        previewCacheLimitMb: 1024,
        notificationsEnabled: false,
        safeTransferEnabled: true,
        hasCompletedFirstRun: true,
      },
      invoke,
    );

    expect(invoke).toHaveBeenNthCalledWith(1, 'get_local_index');
    expect(invoke).toHaveBeenNthCalledWith(2, 'list_drive_jobs');
    expect(invoke).toHaveBeenNthCalledWith(3, 'update_app_settings', {
      settings: {
        themeMode: 'light',
        themeVariant: 'mono',
        defaultViewMode: 'grid',
        gridCardSize: 260,
        syncIntervalMinutes: 30,
        previewCacheLimitMb: 1024,
        notificationsEnabled: false,
        safeTransferEnabled: true,
        hasCompletedFirstRun: true,
      },
    });
  });

  it('routes practical sync, cancellation, sharing, and revision requests to Tauri', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        accounts: [],
        nodes: [],
        syncStates: [],
        jobs: [],
        settings: {
          themeMode: 'dark',
          themeVariant: 'classic',
          defaultViewMode: 'list',
          gridCardSize: 220,
          syncIntervalMinutes: 15,
          previewCacheLimitMb: 512,
          notificationsEnabled: true,
          safeTransferEnabled: true,
          hasCompletedFirstRun: false,
        },
        insights: [],
        duplicateGroups: [],
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce([
        {
          id: 'rev-1',
          modifiedTime: '2026-04-18T14:00:00.000Z',
          mimeType: 'application/pdf',
          size: '1024',
        },
      ]);

    const handle = {
      accountId: 'drive-a',
      googleId: 'file-1',
      filename: 'Roadmap.pdf',
      mimeType: 'application/pdf',
    };

    await syncAccountChanges('drive-a', invoke);
    await cancelDriveJob('job-1', invoke);
    await updateDriveJob('job-1', { status: 'running', progress: 50, errorMessage: null }, invoke);
    await shareDriveNode(handle, 'teammate@example.com', 'reader', invoke);
    const revisions = await listDriveRevisions(handle, invoke);

    expect(invoke).toHaveBeenNthCalledWith(1, 'sync_account_changes', { accountId: 'drive-a' });
    expect(invoke).toHaveBeenNthCalledWith(2, 'cancel_drive_job', { jobId: 'job-1' });
    expect(invoke).toHaveBeenNthCalledWith(3, 'update_drive_job', {
      jobId: 'job-1',
      update: { status: 'running', progress: 50, errorMessage: null },
    });
    expect(invoke).toHaveBeenNthCalledWith(4, 'share_drive_node', {
      accountId: 'drive-a',
      googleId: 'file-1',
      emailAddress: 'teammate@example.com',
      role: 'reader',
    });
    expect(invoke).toHaveBeenNthCalledWith(5, 'list_drive_revisions', {
      accountId: 'drive-a',
      googleId: 'file-1',
    });
    expect(revisions[0]?.id).toBe('rev-1');
  });

  it('bridges Supabase app sessions into the desktop shell', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        userId: 'user-1',
        email: 'zia@example.com',
        emailVerified: true,
      })
      .mockResolvedValueOnce(undefined);

    const sessionSummary = await setDesktopAppSession('access-token', invoke);
    await clearDesktopAppSession(invoke);

    expect(invoke).toHaveBeenNthCalledWith(1, 'set_app_session', {
      accessToken: 'access-token',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'clear_app_session');
    expect(sessionSummary.emailVerified).toBe(true);
  });
});

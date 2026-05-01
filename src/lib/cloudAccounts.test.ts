import { describe, expect, it, vi } from 'vitest';
import type { AccountState } from '../domain/types';
import type { VirtualDriveState } from './driveBackend';
import {
  fetchCloudLinkedAccounts,
  mergeCloudAccountsIntoDriveState,
  syncCloudLinkedAccounts,
} from './cloudAccounts';

const config = {
  supabaseUrl: 'https://demo.supabase.co',
  supabaseAnonKey: 'anon-key',
};

const connectedAccount: AccountState = {
  accountId: 'drive-a',
  label: 'A',
  displayName: 'Drive A',
  email: 'drive-a@example.com',
  sourceKind: 'drive',
  isConnected: true,
  totalBytes: 100,
  usedBytes: 20,
  freeBytes: 80,
  lastSyncedAt: '2026-04-30T12:00:00.000Z',
};

describe('cloudAccounts', () => {
  it('fetches linked account metadata from Supabase', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([
        {
          account_id: 'drive-a',
          label: 'A',
          display_name: 'Drive A',
          email: 'drive-a@example.com',
          source_kind: 'drive',
          last_synced_at: '2026-04-30T12:00:00.000Z',
        },
      ]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const accounts = await fetchCloudLinkedAccounts(config, 'access-token');

    expect(accounts).toEqual([
      {
        accountId: 'drive-a',
        label: 'A',
        displayName: 'Drive A',
        email: 'drive-a@example.com',
        sourceKind: 'drive',
        lastSyncedAt: '2026-04-30T12:00:00.000Z',
      },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/rest/v1/linked_google_accounts');
  });

  it('upserts only currently connected local accounts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await syncCloudLinkedAccounts(config, 'access-token', [
      connectedAccount,
      {
        ...connectedAccount,
        accountId: 'drive-b',
        isConnected: false,
      },
    ]);

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual([
      {
        account_id: 'drive-a',
        label: 'A',
        display_name: 'Drive A',
        email: 'drive-a@example.com',
        source_kind: 'drive',
        last_synced_at: '2026-04-30T12:00:00.000Z',
      },
    ]);
  });

  it('merges cloud-only accounts as reconnect-required entries', () => {
    const state: VirtualDriveState = {
      accounts: [connectedAccount],
      nodes: [],
      requiresDesktopShell: false,
    };

    const merged = mergeCloudAccountsIntoDriveState(state, [
      {
        accountId: 'drive-a',
        label: 'A',
        displayName: 'Drive A',
        sourceKind: 'drive',
      },
      {
        accountId: 'drive-b',
        label: 'B',
        displayName: 'Drive B',
        email: 'drive-b@example.com',
        sourceKind: 'drive',
      },
    ]);

    expect(merged.accounts).toHaveLength(2);
    expect(merged.accounts[1]).toMatchObject({
      accountId: 'drive-b',
      isConnected: false,
      health: 'reconnectRequired',
    });
  });
});

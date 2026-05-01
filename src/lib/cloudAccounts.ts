import type { AccountState } from '../domain/types';
import type { VirtualDriveState } from './driveBackend';
import type { SupabaseConfig } from './authClient';

export interface CloudLinkedAccount {
  accountId: string;
  label: string;
  displayName: string;
  email?: string;
  sourceKind: AccountState['sourceKind'];
  lastSyncedAt?: string;
}

interface CloudLinkedAccountRow {
  account_id: string;
  label: string;
  display_name: string;
  email: string | null;
  source_kind: AccountState['sourceKind'];
  last_synced_at: string | null;
}

function restHeaders(config: SupabaseConfig, accessToken: string): HeadersInit {
  return {
    apikey: config.supabaseAnonKey,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

function toCloudAccount(row: CloudLinkedAccountRow): CloudLinkedAccount {
  return {
    accountId: row.account_id,
    label: row.label,
    displayName: row.display_name,
    email: row.email ?? undefined,
    sourceKind: row.source_kind,
    lastSyncedAt: row.last_synced_at ?? undefined,
  };
}

function toCloudRow(account: AccountState): CloudLinkedAccountRow {
  return {
    account_id: account.accountId,
    label: account.label,
    display_name: account.displayName,
    email: account.email ?? null,
    source_kind: account.sourceKind,
    last_synced_at: account.lastSyncedAt ?? null,
  };
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchCloudLinkedAccounts(
  config: SupabaseConfig,
  accessToken: string,
): Promise<CloudLinkedAccount[]> {
  const url = new URL(`${config.supabaseUrl}/rest/v1/linked_google_accounts`);
  url.searchParams.set('select', 'account_id,label,display_name,email,source_kind,last_synced_at');
  url.searchParams.set('order', 'label.asc');

  const response = await fetch(url, {
    method: 'GET',
    headers: restHeaders(config, accessToken),
  });

  const rows = await readJsonResponse<CloudLinkedAccountRow[]>(response);
  return rows.map(toCloudAccount);
}

export async function syncCloudLinkedAccounts(
  config: SupabaseConfig,
  accessToken: string,
  accounts: AccountState[],
): Promise<void> {
  const connectedAccounts = accounts.filter((account) => account.isConnected);
  if (connectedAccounts.length === 0) {
    return;
  }

  const response = await fetch(`${config.supabaseUrl}/rest/v1/linked_google_accounts`, {
    method: 'POST',
    headers: {
      ...restHeaders(config, accessToken),
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(connectedAccounts.map(toCloudRow)),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }
}

export function mergeCloudAccountsIntoDriveState(
  state: VirtualDriveState,
  cloudAccounts: CloudLinkedAccount[],
): VirtualDriveState {
  const knownAccountIds = new Set(state.accounts.map((account) => account.accountId));
  const reconnectAccounts: AccountState[] = cloudAccounts
    .filter((account) => !knownAccountIds.has(account.accountId))
    .map((account) => ({
      accountId: account.accountId,
      label: account.label,
      displayName: account.displayName,
      email: account.email,
      sourceKind: account.sourceKind,
      isConnected: false,
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      lastSyncedAt: account.lastSyncedAt,
      loadError: 'Reconnect this Google account on this device to restore access.',
      health: 'reconnectRequired',
    }));

  if (reconnectAccounts.length === 0) {
    return state;
  }

  return {
    ...state,
    accounts: [...state.accounts, ...reconnectAccounts],
  };
}

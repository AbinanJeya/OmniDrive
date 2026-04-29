import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { mergeDriveSnapshots } from '../domain/normalize';
import type {
  AppSettings,
  AccountState,
  DriveJob,
  DriveSnapshot,
  LocalIndexPayload,
  PreviewDescriptor,
  StorageInsight,
  UnifiedNode,
} from '../domain/types';

type TauriInvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface VirtualDriveState {
  accounts: AccountState[];
  nodes: UnifiedNode[];
  requiresDesktopShell: boolean;
}

interface LoadVirtualDriveStateOptions {
  isTauriRuntime?: boolean;
  invoke?: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

export interface DesktopAppSessionSummary {
  userId: string;
  email: string;
  emailVerified: boolean;
}

export interface DesktopAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: {
    id: string;
    email: string;
    emailConfirmedAt: string | null;
  };
}

export interface DesktopSupabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface DriveNodeHandle {
  accountId: string;
  googleId: string;
  filename: string;
  mimeType: string;
}

export interface TransferDriveNodeInput extends DriveNodeHandle {}

export function createEmptyVirtualDriveState(
  requiresDesktopShell = false,
): VirtualDriveState {
  return {
    accounts: [],
    nodes: [],
    requiresDesktopShell,
  };
}

export function buildVirtualDriveState(
  snapshots: DriveSnapshot[],
): VirtualDriveState {
  return {
    accounts: snapshots.map((snapshot) => ({
      ...snapshot.account,
      health: deriveAccountHealth(snapshot.account),
    })),
    nodes: mergeDriveSnapshots(...snapshots),
    requiresDesktopShell: false,
  };
}

function deriveAccountHealth(account: AccountState): AccountState['health'] {
  if (account.loadError?.includes('No matching entry found in secure storage')) {
    return 'reconnectRequired';
  }

  if (account.sourceKind === 'photos' && account.loadError) {
    return 'photosPickerExpired';
  }

  if (account.loadError?.toLowerCase().includes('permission')) {
    return 'permissionProblem';
  }

  if (account.loadError) {
    return 'syncError';
  }

  if (account.isConnected && account.totalBytes <= 0) {
    return 'quotaUnavailable';
  }

  return account.isConnected ? 'connected' : 'reconnectRequired';
}

export async function loadVirtualDriveState(
  options: LoadVirtualDriveStateOptions = {},
): Promise<VirtualDriveState> {
  const isTauriRuntime = options.isTauriRuntime ?? hasTauriRuntime();
  if (!isTauriRuntime) {
    return createEmptyVirtualDriveState(true);
  }

  const invoke = options.invoke ?? tauriInvoke;
  const snapshots = await invoke<DriveSnapshot[]>('load_drive_snapshots');
  return buildVirtualDriveState(snapshots);
}

export async function connectGoogleAccount(
  clientIdOrInvoke?: string | TauriInvokeFn,
  invoke: TauriInvokeFn = tauriInvoke,
): Promise<void> {
  const clientId = typeof clientIdOrInvoke === 'string' ? clientIdOrInvoke : undefined;
  const actualInvoke =
    typeof clientIdOrInvoke === 'function' ? clientIdOrInvoke : invoke;
  const requiresDesktopShell = actualInvoke === tauriInvoke;

  if (requiresDesktopShell && !hasTauriRuntime()) {
    throw new Error('Google Drive sign-in is only available inside the desktop shell.');
  }

  if (clientId) {
    await actualInvoke('start_google_oauth', { clientId });
  } else {
    await actualInvoke('start_google_oauth');
  }
}

export async function setDesktopAppSession(
  accessToken: string,
  supabaseConfig?: DesktopSupabaseConfig | TauriInvokeFn,
  invoke: TauriInvokeFn = tauriInvoke,
): Promise<DesktopAppSessionSummary> {
  const actualInvoke = typeof supabaseConfig === 'function' ? supabaseConfig : invoke;
  const actualConfig = typeof supabaseConfig === 'function' ? undefined : supabaseConfig;

  const args: Record<string, unknown> = {
    accessToken,
  };
  if (actualConfig) {
    args.supabaseUrl = actualConfig.supabaseUrl;
    args.supabaseAnonKey = actualConfig.supabaseAnonKey;
  }

  return actualInvoke<DesktopAppSessionSummary>('set_app_session', args);
}

export async function clearDesktopAppSession(
  invoke: TauriInvokeFn = tauriInvoke,
): Promise<void> {
  await invoke('clear_app_session');
}

export async function startDesktopGoogleAuth(
  supabaseConfig: DesktopSupabaseConfig,
  invoke: TauriInvokeFn = tauriInvoke,
): Promise<DesktopAuthSession> {
  if (invoke === tauriInvoke && !hasTauriRuntime()) {
    throw new Error('Google sign-in is only available inside the desktop shell.');
  }

  return invoke<DesktopAuthSession>('start_supabase_google_login', {
    supabaseUrl: supabaseConfig.supabaseUrl,
    supabaseAnonKey: supabaseConfig.supabaseAnonKey,
  });
}

export async function connectGooglePhotosAccount(
  clientIdOrInvoke?: string | TauriInvokeFn,
  invoke: TauriInvokeFn = tauriInvoke,
): Promise<void> {
  const clientId = typeof clientIdOrInvoke === 'string' ? clientIdOrInvoke : undefined;
  const actualInvoke =
    typeof clientIdOrInvoke === 'function' ? clientIdOrInvoke : invoke;
  const requiresDesktopShell = actualInvoke === tauriInvoke;

  if (requiresDesktopShell && !hasTauriRuntime()) {
    throw new Error('Google Photos sign-in is only available inside the desktop shell.');
  }

  if (clientId) {
    await actualInvoke('start_google_photos_oauth', { clientId });
  } else {
    await actualInvoke('start_google_photos_oauth');
  }
}

export async function disconnectGoogleAccount(
  accountId: string,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('delete_stored_tokens', { accountId });
}

export async function createVirtualFolder(
  parentVirtualPath: string,
  folderName: string,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('create_virtual_folder', { parentVirtualPath, folderName });
}

export async function uploadIntoVirtualFolder(
  targetVirtualPath: string,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('upload_into_virtual_folder', { targetVirtualPath });
}

export async function renameDriveNode(
  accountId: string,
  googleId: string,
  nextName: string,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('rename_drive_node', { accountId, googleId, nextName });
}

export async function deleteDriveNode(
  accountId: string,
  googleId: string,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('delete_drive_node', { accountId, googleId });
}

export async function renameVirtualFolder(
  virtualPath: string,
  nextName: string,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('rename_virtual_folder', { virtualPath, nextName });
}

export async function deleteVirtualFolder(
  virtualPath: string,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('delete_virtual_folder', { virtualPath });
}

export async function downloadDriveNode(
  node: DriveNodeHandle,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<string | null> {
  return invoke<string | null>('download_drive_node', {
    accountId: node.accountId,
    googleId: node.googleId,
    filename: node.filename,
    mimeType: node.mimeType,
  });
}

export async function transferDriveNodes(
  nodes: TransferDriveNodeInput[],
  targetAccountId: string,
  targetVirtualPath: string,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<number> {
  return invoke<number>('transfer_drive_nodes', {
    nodes,
    targetAccountId,
    targetVirtualPath,
  });
}

export async function getLocalIndex(
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<LocalIndexPayload> {
  return invoke<LocalIndexPayload>('get_local_index');
}

export async function syncAccountChanges(
  accountId: string,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<LocalIndexPayload> {
  return invoke<LocalIndexPayload>('sync_account_changes', { accountId });
}

export async function listDriveJobs(
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<DriveJob[]> {
  return invoke<DriveJob[]>('list_drive_jobs');
}

export async function enqueueDriveJob(
  job: Pick<DriveJob, 'kind' | 'label' | 'sourceAccountId' | 'targetAccountId'>,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<DriveJob> {
  return invoke<DriveJob>('enqueue_drive_job', { job });
}

export async function cancelDriveJob(
  jobId: string,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('cancel_drive_job', { jobId });
}

export async function updateDriveJob(
  jobId: string,
  update: Pick<DriveJob, 'status' | 'progress' | 'errorMessage'>,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('update_drive_job', { jobId, update });
}

export async function getStorageInsights(
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<StorageInsight[]> {
  return invoke<StorageInsight[]>('get_storage_insights');
}

export async function clearPreviewCache(
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('clear_preview_cache');
}

export async function updateAppSettings(
  settings: AppSettings,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('update_app_settings', { settings });
}

export async function shareDriveNode(
  node: DriveNodeHandle,
  emailAddress: string,
  role: 'reader' | 'commenter' | 'writer',
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<void> {
  await invoke('share_drive_node', {
    accountId: node.accountId,
    googleId: node.googleId,
    emailAddress,
    role,
  });
}

export async function listDriveRevisions(
  node: DriveNodeHandle,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<Array<{ id: string; modifiedTime?: string; mimeType?: string; size?: string }>> {
  return invoke('list_drive_revisions', {
    accountId: node.accountId,
    googleId: node.googleId,
  });
}

export async function prepareDriveNodePreview(
  node: DriveNodeHandle,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<PreviewDescriptor> {
  return invoke<PreviewDescriptor>('prepare_drive_node_preview', {
    accountId: node.accountId,
    googleId: node.googleId,
    filename: node.filename,
    mimeType: node.mimeType,
  });
}

export async function lookupCachedDriveNodePreview(
  node: DriveNodeHandle,
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = tauriInvoke,
): Promise<PreviewDescriptor | null> {
  return invoke<PreviewDescriptor | null>('lookup_cached_drive_node_preview', {
    accountId: node.accountId,
    googleId: node.googleId,
    filename: node.filename,
    mimeType: node.mimeType,
  });
}

function hasTauriRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return '__TAURI_INTERNALS__' in window;
}

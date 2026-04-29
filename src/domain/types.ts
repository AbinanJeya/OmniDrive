export type FileCategory =
  | 'folders'
  | 'documents'
  | 'spreadsheets'
  | 'pdfs'
  | 'images'
  | 'videos'
  | 'audio'
  | 'text'
  | 'archives'
  | 'other';

export type PreviewKind =
  | 'pdf'
  | 'image'
  | 'audio'
  | 'video'
  | 'text'
  | 'docx'
  | 'xlsx'
  | 'unsupported';

export type BrowseScope =
  | { kind: 'all' }
  | { kind: 'account'; accountId: string };

export type BrowseCategory = 'all' | Exclude<FileCategory, 'folders'>;
export type ThemeMode = 'dark' | 'light';
export type ThemeVariant = 'classic' | 'gold' | 'mono';

export type SortField = 'name' | 'modifiedTime' | 'sizeBytes' | 'fileCategory';
export type BrowseViewMode = 'list' | 'grid';

export type AccountHealth =
  | 'connected'
  | 'reconnectRequired'
  | 'quotaUnavailable'
  | 'photosPickerExpired'
  | 'permissionProblem'
  | 'syncError';

export type DriveJobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'failed'
  | 'retrying'
  | 'completed'
  | 'cancelled';

export type DriveJobKind =
  | 'upload'
  | 'download'
  | 'transfer'
  | 'copy'
  | 'delete'
  | 'rename'
  | 'createFolder';

export interface SortModel {
  field: SortField;
  direction: 'asc' | 'desc';
}

export interface FilterModel {
  entryKind: 'all' | 'folders' | 'files';
  category: 'all' | Exclude<FileCategory, 'folders'>;
  sourceAccountId: 'all' | string;
  searchQuery: string;
}

export interface AccountState {
  accountId: string;
  label: string;
  displayName: string;
  email?: string;
  sourceKind: 'drive' | 'photos';
  isConnected: boolean;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  lastSyncedAt?: string;
  loadError?: string | null;
  health?: AccountHealth;
}

export interface UnifiedNode {
  id: string;
  googleId: string;
  accountId: string;
  filename: string;
  isFolder: boolean;
  sizeBytes: number;
  virtualPath: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  viewedByMeTime?: string;
  starred?: boolean;
  shared?: boolean;
  checksum?: string;
  thumbnailState?: 'unknown' | 'cached' | 'unavailable';
  sourceKind?: 'drive' | 'photos';
  previewStatus?: 'previewable' | 'unsupported' | 'oversized' | 'unknown';
  syncVersion?: number;
  fileCategory: FileCategory;
  fileExtension?: string;
  isPreviewable: boolean;
}

export interface GoogleDriveFileRecord {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  parents?: string[];
  trashed?: boolean;
  modifiedTime?: string;
  createdTime?: string;
  viewedByMeTime?: string;
  starred?: boolean;
  shared?: boolean;
  md5Checksum?: string;
  thumbnailLink?: string;
}

export interface DriveSnapshot {
  account: AccountState;
  files: GoogleDriveFileRecord[];
}

export interface SpreadsheetSheet {
  name: string;
  rows: string[][];
}

export interface PreviewDescriptor {
  kind: PreviewKind;
  filename: string;
  mimeType: string;
  accountId: string;
  googleId: string;
  localPath?: string;
  htmlContent?: string;
  textContent?: string;
  sheets?: SpreadsheetSheet[];
  note?: string;
}

export interface GridThumbnailState {
  status: 'loading' | 'ready' | 'error';
  assetKind?: Extract<PreviewKind, 'image' | 'video'>;
  localPath?: string;
}

export interface SyncState {
  accountId: string;
  startPageToken?: string;
  lastSyncedAt?: string;
  lastFullScanAt?: string;
  lastError?: string | null;
  syncVersion: number;
}

export interface DriveJob {
  id: string;
  kind: DriveJobKind;
  status: DriveJobStatus;
  label: string;
  progress: number;
  sourceAccountId?: string;
  targetAccountId?: string;
  createdAt: string;
  updatedAt: string;
  errorMessage?: string | null;
}

export interface StorageInsight {
  id: string;
  kind: 'largeFiles' | 'oldFiles' | 'lowSpace' | 'duplicates' | 'photosLimit';
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  accountId?: string;
  nodeIds: string[];
  reclaimableBytes: number;
}

export interface DuplicateGroup {
  id: string;
  reason: 'checksum' | 'nameAndSize';
  nodes: UnifiedNode[];
  reclaimableBytes: number;
}

export interface LocalIndexDuplicateGroup {
  id: string;
  reason: 'checksum' | 'nameAndSize';
  nodeIds: string[];
  reclaimableBytes: number;
}

export interface AppSettings {
  themeMode: ThemeMode;
  themeVariant: ThemeVariant;
  defaultViewMode: BrowseViewMode;
  gridCardSize: number;
  syncIntervalMinutes: number;
  previewCacheLimitMb: number;
  notificationsEnabled: boolean;
  safeTransferEnabled: boolean;
  downloadDirectory?: string;
  hasCompletedFirstRun: boolean;
}

export interface LocalIndexPayload {
  accounts: AccountState[];
  nodes: UnifiedNode[];
  syncStates: SyncState[];
  jobs: DriveJob[];
  settings: AppSettings;
  insights: StorageInsight[];
  duplicateGroups: LocalIndexDuplicateGroup[];
  lastIndexedAt?: string;
}

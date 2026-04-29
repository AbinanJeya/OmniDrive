import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import {
  ArrowRightLeft,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CheckSquare,
  Chrome,
  Command,
  Contrast,
  Copy,
  Download,
  Eye,
  File,
  FolderPlus,
  FolderOpen,
  History,
  LayoutGrid,
  List,
  LockKeyhole,
  LogOut,
  Mail,
  Moon,
  Pencil,
  RefreshCcw,
  Search,
  Settings,
  Share2,
  Sun,
  Tag,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { DriveGrid } from './components/DriveGrid';
import { DriveSidebar } from './components/DriveSidebar';
import { DriveTable } from './components/DriveTable';
import { FilePreview } from './components/FilePreview';
import { WindowTitleBar } from './components/WindowTitleBar';
import { buildRouteSearch, parseRouteSearch, type AppRoute } from './domain/appRoute';
import { supportsAssetThumbnail } from './domain/browsePresentation';
import {
  duplicateSelectionAccountLabels,
  duplicateSelectionBytes,
  resolveDuplicateReviewGroups,
  totalReclaimableBytes,
  type DuplicateReviewGroup,
} from './domain/duplicateCleanup';
import {
  clampGridCardSize,
  DEFAULT_GRID_CARD_SIZE,
  MAX_GRID_CARD_SIZE,
  MIN_GRID_CARD_SIZE,
} from './domain/gridPresentation';
import {
  computeBrowseRows,
  computeScopeNodes,
  scopeStorageKey,
  type BrowseRow,
} from './domain/browseModel';
import { planGridThumbnailBatch, planThumbnailRowsForView } from './domain/gridThumbnails';
import { computeStorageSummary } from './domain/driveView';
import type {
  AccountState,
  AppSettings,
  BrowseCategory,
  BrowseScope,
  BrowseViewMode,
  DriveJob,
  DriveJobKind,
  FilterModel,
  GridThumbnailState,
  LocalIndexDuplicateGroup,
  PreviewDescriptor,
  SortField,
  SortModel,
  StorageInsight,
  ThemeMode,
  ThemeVariant,
  UnifiedNode,
} from './domain/types';
import {
  clearPreviewCache,
  cancelDriveJob,
  connectGoogleAccount,
  connectGooglePhotosAccount,
  createEmptyVirtualDriveState,
  createVirtualFolder,
  deleteDriveNode,
  deleteVirtualFolder,
  disconnectGoogleAccount,
  downloadDriveNode,
  enqueueDriveJob,
  getLocalIndex,
  listDriveRevisions,
  loadVirtualDriveState,
  lookupCachedDriveNodePreview,
  prepareDriveNodePreview,
  renameDriveNode,
  renameVirtualFolder,
  shareDriveNode,
  syncAccountChanges,
  transferDriveNodes,
  updateDriveJob,
  updateAppSettings,
  uploadIntoVirtualFolder,
  clearDesktopAppSession,
  setDesktopAppSession,
  startDesktopGoogleAuth,
  type DriveNodeHandle,
  type VirtualDriveState,
} from './lib/driveBackend';
import {
  buildSupabaseOAuthUrl,
  clearStoredAuthSession,
  consumeOAuthRedirectSession,
  isVerifiedSession,
  requestPasswordReset,
  resendVerificationEmail,
  restoreAuthSession,
  signInWithPassword,
  signOutSession,
  signUpWithPassword,
  type StoredAuthSession,
} from './lib/authClient';
import { validateSignUpForm } from './lib/authValidation';
import { toUserFacingErrorMessage } from './lib/errorMessage';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          theme?: 'dark' | 'light' | 'auto';
          callback?: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: () => void;
        },
      ) => string;
      remove?: (widgetId: string) => void;
    };
  }
}

interface BrowsePreferences {
  sort: SortModel;
  filters: FilterModel;
}

const VIEW_MODE_STORAGE_KEY = 'omnidrive:view-mode';
const THEME_STORAGE_KEY = 'omnidrive:theme';
const THEME_VARIANT_STORAGE_KEY = 'omnidrive:theme-variant';
const GRID_CARD_SIZE_STORAGE_KEY = 'omnidrive:grid-card-size';

interface MutationJobDescriptor {
  kind: DriveJobKind;
  label: string;
  sourceAccountId?: string;
  targetAccountId?: string;
}

interface RowContextMenuState {
  row: BrowseRow;
  x: number;
  y: number;
}

type AuthScreenMode = 'signIn' | 'signUp' | 'forgotPassword' | 'verifyEmail';
type AuthShellMode = AuthScreenMode;

const DEFAULT_APP_SETTINGS: AppSettings = {
  themeMode: 'dark',
  themeVariant: 'classic',
  defaultViewMode: 'list',
  gridCardSize: DEFAULT_GRID_CARD_SIZE,
  syncIntervalMinutes: 15,
  previewCacheLimitMb: 512,
  notificationsEnabled: true,
  safeTransferEnabled: true,
  hasCompletedFirstRun: false,
};

function humanizeBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const scaled = bytes / 1024 ** exponent;
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[exponent]}`;
}

function createDefaultPreferences(): BrowsePreferences {
  return {
    sort: { field: 'name', direction: 'asc' },
    filters: {
      entryKind: 'all',
      category: 'all',
      sourceAccountId: 'all',
      searchQuery: '',
    },
  };
}

function readInitialViewMode(): BrowseViewMode {
  if (typeof window === 'undefined') {
    return 'list';
  }

  const storedValue = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
  return storedValue === 'grid' || storedValue === 'list' ? storedValue : 'list';
}

function readInitialThemeMode(): ThemeMode {
  if (typeof window === 'undefined') {
    return 'dark';
  }

  const storedValue = window.localStorage.getItem(THEME_STORAGE_KEY);
  return storedValue === 'light' ? 'light' : 'dark';
}

function readInitialThemeVariant(): ThemeVariant {
  if (typeof window === 'undefined') {
    return 'classic';
  }

  const storedValue = window.localStorage.getItem(THEME_VARIANT_STORAGE_KEY);
  return storedValue === 'gold' || storedValue === 'mono' ? storedValue : 'classic';
}

function readInitialGridCardSize(): number {
  if (typeof window === 'undefined') {
    return DEFAULT_GRID_CARD_SIZE;
  }

  const storedValue = Number(window.localStorage.getItem(GRID_CARD_SIZE_STORAGE_KEY));
  return clampGridCardSize(storedValue);
}

function readEnvValue(...keys: string[]): string {
  for (const key of keys) {
    const value = String((import.meta.env as Record<string, unknown>)[key] ?? '').trim();
    if (value.length > 0) {
      return value;
    }
  }

  return '';
}

function scopeLabel(scope: BrowseScope, accounts: AccountState[]): string {
  if (scope.kind === 'account') {
    const account = accounts.find((item) => item.accountId === scope.accountId);
    if (!account) {
      return 'Linked Drive';
    }

    return account.sourceKind === 'photos'
      ? `Photos ${account.label}`
      : `Drive ${account.label}`;
  }

  return 'All Drives';
}

function browseDescription(
  scope: BrowseScope,
  category: BrowseCategory,
  accounts: AccountState[],
): string {
  if (category !== 'all') {
    const label = CATEGORY_LABELS[category].toLowerCase();
    if (scope.kind === 'account') {
      const account = accounts.find((item) => item.accountId === scope.accountId);
      return account
        ? `Browsing ${label} stored only on ${account.displayName}.`
        : `Browsing ${label} in this linked drive.`;
    }

    return `Browsing ${label} across all connected drives.`;
  }

  if (scope.kind === 'account') {
    const account = accounts.find((item) => item.accountId === scope.accountId);
    return account
      ? `Browsing files stored only on ${account.displayName}.`
      : 'Browsing a linked drive.';
  }

  return 'Browse the merged virtual filesystem across every connected Google Drive.';
}

function breadcrumbItems(
  scope: BrowseScope,
  category: BrowseCategory,
  folderPath: string,
  accounts: AccountState[],
) {
  const items = [
    {
      label: scopeLabel(scope, accounts),
      folderPath: '/',
      category: 'all' as BrowseCategory,
    },
  ];

  if (category !== 'all') {
    items.push({
      label: CATEGORY_LABELS[category],
      folderPath: '/',
      category,
    });
    return items;
  }

  if (folderPath === '/') {
    return items;
  }

  const parts = folderPath.slice(1).split('/');
  let currentPath = '';
  for (const part of parts) {
    currentPath += `/${part}`;
    items.push({
      label: part,
      folderPath: currentPath,
      category: 'all' as BrowseCategory,
    });
  }

  return items;
}

function accountFilterAccounts(accounts: AccountState[], scope: BrowseScope): AccountState[] {
  if (scope.kind === 'account') {
    return accounts.filter((account) => account.accountId === scope.accountId);
  }

  return accounts;
}

function storageSummary(accounts: AccountState[]): { total: number; used: number; free: number } {
  const summary = computeStorageSummary(accounts, { kind: 'all' });
  return { total: summary.totalBytes, used: summary.usedBytes, free: summary.freeBytes };
}

function presentLoadError(loadError?: string | null): string | null {
  if (!loadError) {
    return null;
  }

  if (loadError.includes('No matching entry found in secure storage')) {
    return 'This linked account no longer has a stored Google refresh token. Reconnect it to load live storage and files.';
  }

  return loadError;
}

type FileBrowseRow = BrowseRow & {
  entry: Extract<BrowseRow['entry'], { kind: 'file' }>;
};

type DriveRevision = {
  id: string;
  modifiedTime?: string;
  mimeType?: string;
  size?: string;
};

type ShareRole = 'reader' | 'commenter' | 'writer';

function isFileBrowseRow(row: BrowseRow): row is FileBrowseRow {
  return row.entry.kind === 'file';
}

function rowToHandle(row: BrowseRow): DriveNodeHandle | null {
  if (row.entry.kind !== 'file') {
    return null;
  }

  return {
    accountId: row.entry.node.accountId,
    googleId: row.entry.node.googleId,
    filename: row.entry.node.filename,
    mimeType: row.entry.node.mimeType,
  };
}

function nodeToHandle(node: UnifiedNode): DriveNodeHandle {
  return {
    accountId: node.accountId,
    googleId: node.googleId,
    filename: node.filename,
    mimeType: node.mimeType,
  };
}

function parentFolderPath(virtualPath: string): string {
  if (virtualPath === '/' || !virtualPath.startsWith('/')) {
    return '/';
  }

  const lastSeparatorIndex = virtualPath.lastIndexOf('/');
  if (lastSeparatorIndex <= 0) {
    return '/';
  }

  return virtualPath.slice(0, lastSeparatorIndex);
}

function toGridThumbnailState(descriptor: PreviewDescriptor): GridThumbnailState {
  if (
    descriptor.localPath &&
    (descriptor.kind === 'image' || descriptor.kind === 'video')
  ) {
    return {
      status: 'ready',
      assetKind: descriptor.kind,
      localPath: descriptor.localPath,
    };
  }

  return { status: 'error' };
}

const CATEGORY_LABELS = {
  documents: 'Documents',
  spreadsheets: 'Spreadsheets',
  pdfs: 'PDFs',
  images: 'Images',
  videos: 'Videos',
  audio: 'Audio',
  text: 'Text',
  archives: 'Archives',
  other: 'Other',
} as const;

export default function App() {
  const supabaseConfig = useMemo(
    () => ({
      supabaseUrl: readEnvValue('VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'),
      supabaseAnonKey: readEnvValue(
        'VITE_SUPABASE_ANON_KEY',
        'VITE_SUPABASE_PUBLISHABLE_KEY',
        'NEXT_PUBLIC_SUPABASE_ANON_KEY',
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      ),
    }),
    [],
  );
  const turnstileSiteKey = useMemo(
    () => readEnvValue('VITE_TURNSTILE_SITE_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY'),
    [],
  );
  const googleClientId = useMemo(
    () => readEnvValue('VITE_GOOGLE_CLIENT_ID', 'NEXT_PUBLIC_GOOGLE_CLIENT_ID'),
    [],
  );
  const hasSupabaseConfig = Boolean(supabaseConfig.supabaseUrl && supabaseConfig.supabaseAnonKey);
  const [authSession, setAuthSession] = useState<StoredAuthSession | null>(null);
  const [authStatus, setAuthStatus] = useState<'loading' | 'locked' | 'ready'>('loading');
  const [authScreenMode, setAuthScreenMode] = useState<AuthScreenMode>('signIn');
  const [authPendingEmail, setAuthPendingEmail] = useState('');
  const [authErrorMessage, setAuthErrorMessage] = useState<string | null>(null);
  const [authNoticeMessage, setAuthNoticeMessage] = useState<string | null>(null);
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const [driveState, setDriveState] = useState<VirtualDriveState>(() =>
    createEmptyVirtualDriveState(false),
  );
  const [route, setRoute] = useState<AppRoute>(() => parseRouteSearch(window.location.search));
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readInitialThemeMode());
  const [themeVariant, setThemeVariant] = useState<ThemeVariant>(() => readInitialThemeVariant());
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>(() => ({
    ...DEFAULT_APP_SETTINGS,
    themeMode: readInitialThemeMode(),
    themeVariant: readInitialThemeVariant(),
    defaultViewMode: readInitialViewMode(),
    gridCardSize: readInitialGridCardSize(),
  }));
  const [driveJobs, setDriveJobs] = useState<DriveJob[]>([]);
  const [storageInsights, setStorageInsights] = useState<StorageInsight[]>([]);
  const [duplicateGroups, setDuplicateGroups] = useState<LocalIndexDuplicateGroup[]>([]);
  const [preferencesByScope, setPreferencesByScope] = useState<Record<string, BrowsePreferences>>(
    {},
  );
  const [viewMode, setViewMode] = useState<BrowseViewMode>(() => readInitialViewMode());
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [previewDescriptor, setPreviewDescriptor] = useState<PreviewDescriptor | null>(null);
  const [gridThumbnails, setGridThumbnails] = useState<Record<string, GridThumbnailState>>({});
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<RowContextMenuState | null>(null);
  const [revisionPanel, setRevisionPanel] = useState<{
    node: UnifiedNode;
    revisions: DriveRevision[];
    isLoading: boolean;
    errorMessage: string | null;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const isWorkspaceUnlocked = authStatus === 'ready' && Boolean(authSession);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!hasSupabaseConfig) {
        setAuthErrorMessage(
          'Set VITE_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL and VITE_SUPABASE_ANON_KEY / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY before opening OmniDrive.',
        );
        setAuthStatus('locked');
        return;
      }

      try {
        const redirectSession = await consumeOAuthRedirectSession(supabaseConfig);
        if (redirectSession) {
          if (!isVerifiedSession(redirectSession)) {
            clearStoredAuthSession();
            if (!cancelled) {
              setAuthPendingEmail(redirectSession.user.email);
              setAuthStatus('locked');
              setAuthScreenMode('verifyEmail');
              setAuthNoticeMessage(`Verify ${redirectSession.user.email} to unlock OmniDrive.`);
            }
            return;
          }

          await setDesktopAppSession(redirectSession.accessToken, supabaseConfig);
          if (!cancelled) {
            setAuthSession(redirectSession);
            setAuthStatus('ready');
            setAuthScreenMode('signIn');
            setAuthPendingEmail(redirectSession.user.email);
          }
          return;
        }

        const restoredSession = await restoreAuthSession(supabaseConfig);
        if (!restoredSession) {
          if (!cancelled) {
            setAuthStatus('locked');
            setAuthScreenMode('signIn');
          }
          return;
        }

        if (!isVerifiedSession(restoredSession)) {
          clearStoredAuthSession();
          if (!cancelled) {
            setAuthPendingEmail(restoredSession.user.email);
            setAuthStatus('locked');
            setAuthScreenMode('verifyEmail');
            setAuthNoticeMessage(`Verify ${restoredSession.user.email} to unlock OmniDrive.`);
          }
          return;
        }

        await setDesktopAppSession(restoredSession.accessToken, supabaseConfig);
        if (!cancelled) {
          setAuthSession(restoredSession);
          setAuthStatus('ready');
          setAuthScreenMode('signIn');
          setAuthPendingEmail(restoredSession.user.email);
        }
      } catch (error) {
        clearStoredAuthSession();
        await clearDesktopAppSession().catch(() => undefined);
        if (!cancelled) {
          setAuthErrorMessage(
            toUserFacingErrorMessage(error, 'OmniDrive could not restore your session.'),
          );
          setAuthStatus('locked');
          setAuthScreenMode('signIn');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasSupabaseConfig, supabaseConfig]);

  useEffect(() => {
    if (!isWorkspaceUnlocked) {
      return;
    }

    void refreshDriveState();
    void refreshLocalFoundation();
  }, [isWorkspaceUnlocked]);

  useEffect(() => {
    const handlePopState = () => {
      if (!isWorkspaceUnlocked) {
        return;
      }

      setRoute(parseRouteSearch(window.location.search));
      setSelectedRowIds([]);
      setIsSelectMode(false);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isWorkspaceUnlocked]);

  useEffect(() => {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    window.localStorage.setItem(THEME_VARIANT_STORAGE_KEY, themeVariant);
  }, [themeVariant]);

  useEffect(() => {
    window.localStorage.setItem(GRID_CARD_SIZE_STORAGE_KEY, String(appSettings.gridCardSize));
  }, [appSettings.gridCardSize]);

  useEffect(() => {
    setAppSettings((current) => ({
      ...current,
      themeMode,
      themeVariant,
      defaultViewMode: viewMode,
    }));
  }, [themeMode, themeVariant, viewMode]);

  const scopeKey = scopeStorageKey(route.scope);
  const preferences = preferencesByScope[scopeKey] ?? createDefaultPreferences();

  const visibleAccounts = useMemo(
    () => accountFilterAccounts(driveState.accounts, route.scope),
    [driveState.accounts, route.scope],
  );
  const scopedNodes = useMemo(
    () => computeScopeNodes(driveState.nodes, route.scope),
    [driveState.nodes, route.scope],
  );
  const browseRows = useMemo(
    () =>
      computeBrowseRows({
        nodes: driveState.nodes,
        accounts: driveState.accounts,
        scope: route.scope,
        category: route.category,
        folderPath: route.folderPath,
        filters: preferences.filters,
        sort: preferences.sort,
      }),
    [
      driveState.accounts,
      driveState.nodes,
      preferences.filters,
      preferences.sort,
      route.category,
      route.folderPath,
      route.scope,
    ],
  );
  const selectedRows = useMemo(
    () => selectedRowIds
      .map((id) => browseRows.find((row) => row.id === id))
      .filter((row): row is BrowseRow => Boolean(row)),
    [browseRows, selectedRowIds],
  );
  const selectedRow = selectedRows.length === 1 ? selectedRows[0] : null;
  const thumbnailRows = useMemo(
    () =>
      route.view === 'browse'
        ? planThumbnailRowsForView(browseRows.filter(supportsAssetThumbnail), viewMode)
        : [],
    [browseRows, route.view, viewMode],
  );
  const previewNode = useMemo(
    () =>
      route.view === 'preview'
        ? scopedNodes.find((node) => node.id === route.nodeId) ?? null
        : null,
    [route, scopedNodes],
  );
  const summary = useMemo(() => storageSummary(visibleAccounts), [visibleAccounts]);
  const visibleLoadErrors = useMemo(
    () =>
      visibleAccounts
        .map((account) => presentLoadError(account.loadError))
        .filter((message): message is string => Boolean(message)),
    [visibleAccounts],
  );
  const currentTitle =
    route.view === 'preview' && previewNode
      ? previewNode.filename
      : route.category !== 'all'
        ? CATEGORY_LABELS[route.category]
      : route.folderPath === '/'
        ? scopeLabel(route.scope, driveState.accounts)
        : route.folderPath.split('/').filter(Boolean).at(-1) ??
          scopeLabel(route.scope, driveState.accounts);
  const currentDescription =
    route.view === 'preview' && previewNode
      ? `Previewing ${previewNode.filename} without leaving OmniDrive.`
      : browseDescription(route.scope, route.category, driveState.accounts);
  const breadcrumbs = useMemo(
    () => breadcrumbItems(route.scope, route.category, route.folderPath, driveState.accounts),
    [driveState.accounts, route.category, route.folderPath, route.scope],
  );

  useEffect(() => {
    if (selectedRowIds.length === 0) {
      return;
    }

    const visibleRowIds = new Set(browseRows.map((row) => row.id));
    const nextSelectedIds = selectedRowIds.filter((id) => visibleRowIds.has(id));
    if (nextSelectedIds.length !== selectedRowIds.length) {
      setSelectedRowIds(nextSelectedIds);
    }
  }, [browseRows, selectedRowIds]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setContextMenu(null);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu || !contextMenuRef.current) {
      return;
    }

    const viewportPadding = 12;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const nextX = Math.min(
      Math.max(viewportPadding, contextMenu.x),
      window.innerWidth - rect.width - viewportPadding,
    );
    const nextY = Math.min(
      Math.max(viewportPadding, contextMenu.y),
      window.innerHeight - rect.height - viewportPadding,
    );

    if (nextX !== contextMenu.x || nextY !== contextMenu.y) {
      setContextMenu((current) =>
        current
          ? {
              ...current,
              x: nextX,
              y: nextY,
            }
          : current,
      );
    }
  }, [contextMenu]);

  useEffect(() => {
    if (!isAccountMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (accountMenuRef.current?.contains(event.target as Node)) {
        return;
      }

      setIsAccountMenuOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsAccountMenuOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isAccountMenuOpen]);

  useEffect(() => {
    const handleNativeContextMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (
        target.closest('input, textarea, [contenteditable="true"]') &&
        !target.closest('[data-drive-context-target]')
      ) {
        return;
      }

      if (target.closest('[data-drive-context-target]') || target.closest('[data-custom-context-menu]')) {
        event.preventDefault();
      }
    };

    window.addEventListener('contextmenu', handleNativeContextMenu, true);
    return () => window.removeEventListener('contextmenu', handleNativeContextMenu, true);
  }, []);

  useEffect(() => {
    if (
      !isWorkspaceUnlocked ||
      route.view !== 'browse' ||
      viewMode !== 'grid' ||
      driveState.requiresDesktopShell
    ) {
      return;
    }

    const batch = planGridThumbnailBatch(thumbnailRows, gridThumbnails);
    if (batch.rowsToLoad.length === 0) {
      return;
    }

    let cancelled = false;
    setGridThumbnails(batch.nextState);

    void (async () => {
      const candidates = batch.rowsToLoad
        .map((row) => {
          const handle = rowToHandle(row);
          return handle ? { row, handle } : { row, handle: null };
        });

      const cachedResults = await Promise.all(
        candidates.map(async (candidate) => {
          if (!candidate.handle) {
            return { ...candidate, descriptor: null };
          }

          try {
            const descriptor = await lookupCachedDriveNodePreview(candidate.handle);
            return { ...candidate, descriptor };
          } catch {
            return { ...candidate, descriptor: null };
          }
        }),
      );

      if (cancelled) {
        return;
      }

      const rowsToPrepare = cachedResults
        .filter(
          (candidate): candidate is { row: BrowseRow; handle: DriveNodeHandle; descriptor: PreviewDescriptor | null } =>
            Boolean(candidate.handle),
        )
        .filter((candidate) => !candidate.descriptor?.localPath);

      setGridThumbnails((current) => {
        const nextState = { ...current };

        for (const candidate of cachedResults) {
          if (!candidate.handle) {
            nextState[candidate.row.id] = { status: 'error' };
            continue;
          }

          if (candidate.descriptor?.localPath) {
            nextState[candidate.row.id] = toGridThumbnailState(candidate.descriptor);
          }
        }

        return nextState;
      });

      for (const candidate of rowsToPrepare) {
        if (cancelled) {
          return;
        }

        try {
          const descriptor = await prepareDriveNodePreview(candidate.handle);
          if (cancelled) {
            return;
          }

          setGridThumbnails((current) => ({
            ...current,
            [candidate.row.id]: toGridThumbnailState(descriptor),
          }));
        } catch {
          if (cancelled) {
            return;
          }

          setGridThumbnails((current) => ({
            ...current,
            [candidate.row.id]: { status: 'error' },
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    driveState.requiresDesktopShell,
    isWorkspaceUnlocked,
    thumbnailRows,
    route.view,
    viewMode,
  ]);

  useEffect(() => {
    if (!isWorkspaceUnlocked || route.view !== 'preview' || !previewNode) {
      setPreviewDescriptor(null);
      setPreviewError(null);
      setIsPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setIsPreviewLoading(true);
    setPreviewError(null);

    void prepareDriveNodePreview(nodeToHandle(previewNode))
      .then((descriptor) => {
        if (cancelled) {
          return;
        }
        setPreviewDescriptor(descriptor);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setPreviewError(toUserFacingErrorMessage(error, 'OmniDrive could not prepare that preview.'));
      })
      .finally(() => {
        if (!cancelled) {
          setIsPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isWorkspaceUnlocked, previewNode, route.view]);

  function navigate(nextRoute: AppRoute, replace = false) {
    const search = buildRouteSearch(nextRoute);
    const nextUrl = `${window.location.pathname}${search}`;
    if (replace) {
      window.history.replaceState({}, '', nextUrl);
    } else {
      window.history.pushState({}, '', nextUrl);
    }
    setRoute(nextRoute);
  }

  function updatePreferences(updater: (current: BrowsePreferences) => BrowsePreferences) {
    setPreferencesByScope((current) => ({
      ...current,
      [scopeKey]: updater(current[scopeKey] ?? createDefaultPreferences()),
    }));
  }

  async function refreshDriveState(): Promise<boolean> {
    if (!isWorkspaceUnlocked) {
      return false;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const nextState = await loadVirtualDriveState();
      startTransition(() => {
        setDriveState(nextState);
      });
      await refreshLocalFoundation();
      return true;
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, 'Failed to load Google Drive data.'));
      return false;
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSyncVisibleScope() {
    setIsLoading(true);
    setErrorMessage(null);
    setNoticeMessage(null);

    try {
      const activeScope = route.scope;
      if (activeScope.kind === 'account') {
        const account = driveState.accounts.find((item) => item.accountId === activeScope.accountId);
        if (account?.sourceKind === 'drive') {
          await syncAccountChanges(activeScope.accountId);
          if (await refreshDriveState()) {
            setNoticeMessage(`Synced Drive ${account.label} changes.`);
          }
          return;
        }
      }

      if (await refreshDriveState()) {
        setNoticeMessage('Index refreshed.');
      }
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, 'OmniDrive could not sync this view.'));
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshLocalFoundation() {
    if (!isWorkspaceUnlocked) {
      return;
    }

    try {
      const localIndex = await getLocalIndex();
      setDriveJobs(localIndex.jobs);
      setStorageInsights(localIndex.insights);
      setDuplicateGroups(localIndex.duplicateGroups);
      setAppSettings({
        ...localIndex.settings,
        gridCardSize: clampGridCardSize(localIndex.settings.gridCardSize ?? DEFAULT_GRID_CARD_SIZE),
      });
      setThemeMode(localIndex.settings.themeMode);
      setThemeVariant(localIndex.settings.themeVariant ?? 'classic');
      setViewMode(localIndex.settings.defaultViewMode);
    } catch {
      // The browser-only dev server cannot access the Tauri local index.
    }
  }

  async function persistAppSettings(nextSettings: AppSettings) {
    const normalizedSettings = {
      ...nextSettings,
      gridCardSize: clampGridCardSize(nextSettings.gridCardSize),
    };

    setAppSettings(normalizedSettings);
    setThemeMode(normalizedSettings.themeMode);
    setThemeVariant(normalizedSettings.themeVariant);
    setViewMode(normalizedSettings.defaultViewMode);
    window.localStorage.setItem(THEME_STORAGE_KEY, normalizedSettings.themeMode);
    window.localStorage.setItem(THEME_VARIANT_STORAGE_KEY, normalizedSettings.themeVariant);
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, normalizedSettings.defaultViewMode);
    window.localStorage.setItem(GRID_CARD_SIZE_STORAGE_KEY, String(normalizedSettings.gridCardSize));
    try {
      await updateAppSettings(normalizedSettings);
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, 'OmniDrive could not save settings.'));
    }
  }

  function resetWorkspaceState() {
    setDriveState(createEmptyVirtualDriveState(false));
    setDriveJobs([]);
    setStorageInsights([]);
    setDuplicateGroups([]);
    setPreferencesByScope({});
    setIsSelectMode(false);
    setSelectedRowIds([]);
    setPreviewDescriptor(null);
    setGridThumbnails({});
    setPreviewError(null);
    setIsPreviewLoading(false);
    setIsLoading(false);
    setIsConnecting(false);
    setIsMutating(false);
    setErrorMessage(null);
    setNoticeMessage(null);
    setContextMenu(null);
    setRevisionPanel(null);
    setIsCommandPaletteOpen(false);
    setIsSettingsOpen(false);
    navigate({ view: 'browse', scope: { kind: 'all' }, category: 'all', folderPath: '/' }, true);
  }

  async function handleAuthSignIn(email: string, password: string, captchaToken?: string) {
    if (!hasSupabaseConfig) {
      setAuthErrorMessage('Supabase is not configured for this build.');
      return;
    }

    setIsAuthSubmitting(true);
    setAuthErrorMessage(null);
    setAuthNoticeMessage(null);

    try {
      const session = await signInWithPassword({
        ...supabaseConfig,
        email,
        password,
        captchaToken,
      });

      if (!isVerifiedSession(session)) {
        clearStoredAuthSession();
        setAuthPendingEmail(email);
        setAuthScreenMode('verifyEmail');
        setAuthStatus('locked');
        setAuthNoticeMessage(`Verify ${email} before opening OmniDrive.`);
        return;
      }

      await setDesktopAppSession(session.accessToken, supabaseConfig);
      resetWorkspaceState();
      setAuthSession(session);
      setAuthPendingEmail(email);
      setAuthStatus('ready');
      setAuthNoticeMessage(null);
    } catch (error) {
      setAuthErrorMessage(toUserFacingErrorMessage(error, 'OmniDrive sign-in failed.'));
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  async function handleAuthSignUp(email: string, password: string, captchaToken?: string) {
    if (!hasSupabaseConfig) {
      setAuthErrorMessage('Supabase is not configured for this build.');
      return;
    }

    setIsAuthSubmitting(true);
    setAuthErrorMessage(null);
    setAuthNoticeMessage(null);

    try {
      await signUpWithPassword({
        ...supabaseConfig,
        email,
        password,
        captchaToken,
      });
      setAuthPendingEmail(email);
      setAuthScreenMode('verifyEmail');
      setAuthStatus('locked');
      setAuthNoticeMessage(`Check ${email} for the verification link.`);
    } catch (error) {
      setAuthErrorMessage(toUserFacingErrorMessage(error, 'OmniDrive sign-up failed.'));
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  async function handleResendVerification() {
    if (!hasSupabaseConfig || !authPendingEmail) {
      return;
    }

    setIsAuthSubmitting(true);
    setAuthErrorMessage(null);
    setAuthNoticeMessage(null);

    try {
      await resendVerificationEmail({
        ...supabaseConfig,
        email: authPendingEmail,
      });
      setAuthNoticeMessage(`Sent another verification email to ${authPendingEmail}.`);
    } catch (error) {
      setAuthErrorMessage(
        toUserFacingErrorMessage(error, 'OmniDrive could not resend the verification email.'),
      );
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  async function handlePasswordReset(email: string, captchaToken?: string) {
    if (!hasSupabaseConfig) {
      setAuthErrorMessage('Supabase is not configured for this build.');
      return;
    }

    setIsAuthSubmitting(true);
    setAuthErrorMessage(null);
    setAuthNoticeMessage(null);

    try {
      await requestPasswordReset({
        ...supabaseConfig,
        email,
        captchaToken,
      });
      setAuthPendingEmail(email);
      setAuthScreenMode('signIn');
      setAuthNoticeMessage(`Password reset instructions were sent to ${email}.`);
    } catch (error) {
      setAuthErrorMessage(
        toUserFacingErrorMessage(error, 'OmniDrive could not send the reset email.'),
      );
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  async function handleSignOut() {
    setIsAccountMenuOpen(false);
    setIsAuthSubmitting(true);

    try {
      if (authSession) {
        await signOutSession({
          ...supabaseConfig,
          accessToken: authSession.accessToken,
        }).catch(() => undefined);
      }

      clearStoredAuthSession();
      await clearDesktopAppSession().catch(() => undefined);
      resetWorkspaceState();
      setAuthSession(null);
      setAuthStatus('locked');
      setAuthScreenMode('signIn');
      setAuthNoticeMessage('Signed out of OmniDrive.');
      setAuthErrorMessage(null);
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  async function handleLockedSignOut() {
    setIsAuthSubmitting(true);

    try {
      clearStoredAuthSession();
      await clearDesktopAppSession().catch(() => undefined);
      resetWorkspaceState();
      setAuthSession(null);
      setAuthStatus('locked');
      setAuthScreenMode('signIn');
      setAuthPendingEmail('');
      setAuthNoticeMessage('Signed out of OmniDrive.');
      setAuthErrorMessage(null);
    } finally {
      setIsAuthSubmitting(false);
    }
  }

  async function handleVerifyEmailCheck() {
    setAuthErrorMessage(null);
    setAuthNoticeMessage(null);
    setAuthScreenMode('signIn');
  }

  async function unlockWithSession(session: StoredAuthSession) {
    if (!isVerifiedSession(session)) {
      clearStoredAuthSession();
      setAuthPendingEmail(session.user.email);
      setAuthScreenMode('verifyEmail');
      setAuthStatus('locked');
      setAuthNoticeMessage(`Verify ${session.user.email} before opening OmniDrive.`);
      return;
    }

    await setDesktopAppSession(session.accessToken, supabaseConfig);
    resetWorkspaceState();
    setAuthSession(session);
    setAuthPendingEmail(session.user.email);
    setAuthStatus('ready');
    setAuthNoticeMessage(null);
  }

  async function handleGoogleSignIn(captchaToken?: string) {
    if (!hasSupabaseConfig) {
      setAuthErrorMessage('Supabase is not configured for this build.');
      return;
    }

    setIsAuthSubmitting(true);
    setAuthErrorMessage(null);
    setAuthNoticeMessage(null);

    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        const desktopSession = await startDesktopGoogleAuth(supabaseConfig, captchaToken);
        await unlockWithSession(desktopSession);
        return;
      }

      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      window.location.assign(
        buildSupabaseOAuthUrl({
          ...supabaseConfig,
          provider: 'google',
          redirectTo,
          captchaToken,
        }),
      );
    } catch (error) {
      setAuthErrorMessage(toUserFacingErrorMessage(error, 'OmniDrive Google sign-in failed.'));
    }
    setIsAuthSubmitting(false);
  }

  async function runMutation(
    action: () => Promise<string | number | void | null | undefined>,
    successMessage: string,
    options?: { refresh?: boolean; clearSelection?: boolean; job?: MutationJobDescriptor },
  ) {
    setIsMutating(true);
    setErrorMessage(null);
    setNoticeMessage(null);
    let trackedJobId: string | null = null;

    async function updateTrackedJob(
      status: DriveJob['status'],
      progress: number,
      errorMessage: string | null = null,
    ) {
      if (!trackedJobId) {
        return;
      }

      try {
        await updateDriveJob(trackedJobId, { status, progress, errorMessage });
      } catch {
        // Job history should never block the actual Drive operation from completing.
      }
    }

    try {
      if (options?.job) {
        try {
          const job = await enqueueDriveJob(options.job);
          trackedJobId = job.id;
          setDriveJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
          await updateTrackedJob('running', 5, null);
          await refreshLocalFoundation();
        } catch {
          // If local indexing is unavailable, keep the requested user action moving.
        }
      }

      const result = await action();
      const shouldRefresh = options?.refresh ?? true;
      const shouldClearSelection = options?.clearSelection ?? false;

      if (typeof result === 'number' && result === 0) {
        await updateTrackedJob('completed', 100, null);
        await refreshLocalFoundation();
        return;
      }

      await updateTrackedJob('completed', 100, null);

      if (shouldRefresh) {
        await refreshDriveState();
      } else {
        await refreshLocalFoundation();
      }
      if (shouldClearSelection) {
        setSelectedRowIds([]);
        setIsSelectMode(false);
      }

      if (typeof result === 'string' && result.trim().length > 0) {
        setNoticeMessage(`${successMessage} ${result}`);
      } else {
        setNoticeMessage(successMessage);
      }
    } catch (error) {
      const message = toUserFacingErrorMessage(error, 'OmniDrive could not complete that action.');
      await updateTrackedJob('failed', 100, message);
      await refreshLocalFoundation();
      setErrorMessage(message);
    } finally {
      setIsMutating(false);
    }
  }

  async function handleConnectGoogleAccount() {
    setIsConnecting(true);
    setErrorMessage(null);
    setNoticeMessage(null);

    try {
      await connectGoogleAccount(googleClientId || undefined);
      await refreshDriveState();
      setNoticeMessage('Google Drive account connected.');
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, 'Failed to connect Google Drive.'));
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleConnectGooglePhotosAccount() {
    setIsConnecting(true);
    setErrorMessage(null);
    setNoticeMessage(null);

    try {
      await connectGooglePhotosAccount(googleClientId || undefined);
      await refreshDriveState();
      setNoticeMessage('Google Photos connected.');
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, 'Failed to connect Google Photos.'));
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleCreateFolder() {
    const folderName = window.prompt('Folder name', 'New Folder');
    if (!folderName) {
      return;
    }

    await runMutation(
      () => createVirtualFolder(route.folderPath, folderName),
      `Created folder in ${route.folderPath}.`,
      {
        clearSelection: true,
        job: { kind: 'createFolder', label: `Create folder ${folderName}` },
      },
    );
  }

  async function handleUploadFile() {
    await runMutation(
      () => uploadIntoVirtualFolder(route.folderPath),
      `Upload completed into ${route.folderPath}.`,
      { job: { kind: 'upload', label: `Upload into ${route.folderPath}` } },
    );
  }

  async function handleUploadIntoFolder(targetVirtualPath: string) {
    await runMutation(
      () => uploadIntoVirtualFolder(targetVirtualPath),
      `Upload completed into ${targetVirtualPath}.`,
      { job: { kind: 'upload', label: `Upload into ${targetVirtualPath}` } },
    );
  }

  async function handleCreateFolderIn(targetVirtualPath: string) {
    const folderName = window.prompt('Folder name', 'New Folder');
    if (!folderName) {
      return;
    }

    await runMutation(
      () => createVirtualFolder(targetVirtualPath, folderName),
      `Created folder in ${targetVirtualPath}.`,
      {
        clearSelection: true,
        job: { kind: 'createFolder', label: `Create folder ${folderName}` },
      },
    );
  }

  async function handleRenameSelection() {
    if (!selectedRow) {
      return;
    }

    if (selectedRow.entry.kind === 'file') {
      const selectedFile = selectedRow.entry.node;
      const nextName = window.prompt('Rename file', selectedFile.filename);
      if (!nextName || nextName === selectedFile.filename) {
        return;
      }

      await runMutation(
        () => renameDriveNode(selectedFile.accountId, selectedFile.googleId, nextName),
        'File renamed.',
        {
          clearSelection: true,
          job: {
            kind: 'rename',
            label: `Rename ${selectedFile.filename}`,
            sourceAccountId: selectedFile.accountId,
          },
        },
      );
      return;
    }

    if (selectedRow.virtualPath !== '/') {
      const nextName = window.prompt('Rename folder', selectedRow.name);
      if (!nextName || nextName === selectedRow.name) {
        return;
      }

      await runMutation(
        () => renameVirtualFolder(selectedRow.virtualPath, nextName),
        'Folder renamed across OmniDrive.',
        {
          clearSelection: true,
          job: { kind: 'rename', label: `Rename folder ${selectedRow.name}` },
        },
      );
    }
  }

  function accountForRow(row: BrowseRow): AccountState | null {
    if (!isFileBrowseRow(row)) {
      return null;
    }

    return driveState.accounts.find((account) => account.accountId === row.entry.node.accountId) ?? null;
  }

  function isRowDeletable(row: BrowseRow): boolean {
    if (row.entry.kind === 'directory') {
      return row.virtualPath !== '/';
    }

    return accountForRow(row)?.sourceKind === 'drive';
  }

  async function handleDeleteSelection() {
    if (selectedRows.length === 0) {
      return;
    }

    if (!selectedRows.every(isRowDeletable)) {
      setErrorMessage('Delete is only available for Google Drive files and non-root virtual folders.');
      return;
    }

    if (selectedRows.length > 1) {
      const confirmed = window.confirm(`Delete ${selectedRows.length} selected items?`);
      if (!confirmed) {
        return;
      }

      await runMutation(
        async () => {
          for (const row of selectedRows) {
            if (row.entry.kind === 'file') {
              const selectedFile = row.entry.node;
              await deleteDriveNode(selectedFile.accountId, selectedFile.googleId);
            } else if (row.virtualPath !== '/') {
              await deleteVirtualFolder(row.virtualPath);
            }
          }
        },
        'Selected items deleted.',
        {
          clearSelection: true,
          job: { kind: 'delete', label: `Delete ${selectedRows.length} selected items` },
        },
      );
      return;
    }

    if (!selectedRow) {
      return;
    }

    if (selectedRow.entry.kind === 'file') {
      const selectedFile = selectedRow.entry.node;
      const confirmed = window.confirm(`Delete ${selectedRow.name} from Google Drive?`);
      if (!confirmed) {
        return;
      }

      await runMutation(
        () => deleteDriveNode(selectedFile.accountId, selectedFile.googleId),
        'File deleted.',
        {
          clearSelection: true,
          job: {
            kind: 'delete',
            label: `Delete ${selectedFile.filename}`,
            sourceAccountId: selectedFile.accountId,
          },
        },
      );
      return;
    }

    if (selectedRow.virtualPath !== '/') {
      const confirmed = window.confirm(
        `Delete the virtual folder ${selectedRow.virtualPath} from every backing account?`,
      );
      if (!confirmed) {
        return;
      }

      await runMutation(
        () => deleteVirtualFolder(selectedRow.virtualPath),
        'Folder deleted from all backing accounts.',
        {
          clearSelection: true,
          job: { kind: 'delete', label: `Delete folder ${selectedRow.name}` },
        },
      );
    }
  }

  async function handleDownloadSelected() {
    const fileHandle =
      selectedRow?.entry.kind === 'file' ? rowToHandle(selectedRow) : previewNode ? nodeToHandle(previewNode) : null;
    if (!fileHandle) {
      return;
    }

    await runMutation(
      () => downloadDriveNode(fileHandle),
      'Downloaded to',
      {
        refresh: false,
        job: {
          kind: 'download',
          label: `Download ${fileHandle.filename}`,
          sourceAccountId: fileHandle.accountId,
        },
      },
    );
  }

  async function handleTransferSelected() {
    const selectedFiles = selectedRows
      .filter(isFileBrowseRow)
      .map((row) => row.entry.node)
      .filter((node) => {
        const account = driveState.accounts.find((item) => item.accountId === node.accountId);
        return account?.sourceKind === 'drive';
      });
    if (selectedFiles.length === 0) {
      return;
    }

    if (selectedFiles.length !== selectedRows.length) {
      setErrorMessage('Transfer only supports selected Google Drive files. Folders and Google Photos items are read-only for transfers.');
      return;
    }

    const targetAccounts = driveState.accounts.filter((account) => {
      if (account.sourceKind !== 'drive' || !account.isConnected) {
        return false;
      }

      return selectedFiles.some((file) => file.accountId !== account.accountId);
    });
    if (targetAccounts.length === 0) {
      setErrorMessage('Connect another Google Drive account before transferring files.');
      return;
    }

    const targetPrompt = targetAccounts
      .map((account) => `${account.label}: ${account.displayName}`)
      .join('\n');
    const targetLabel = window.prompt(`Transfer to which drive?\n${targetPrompt}`, targetAccounts[0]?.label ?? '');
    if (!targetLabel) {
      return;
    }

    const normalizedTarget = targetLabel.trim().toLowerCase();
    const targetAccount = targetAccounts.find(
      (account) =>
        account.label.toLowerCase() === normalizedTarget ||
        account.displayName.toLowerCase() === normalizedTarget ||
        account.email?.toLowerCase() === normalizedTarget,
    );
    if (!targetAccount) {
      setErrorMessage('That target drive was not found. Use the drive label shown in the prompt.');
      return;
    }

    await runMutation(
      () =>
        transferDriveNodes(
          selectedFiles.map((file) => nodeToHandle(file)),
          targetAccount.accountId,
          route.folderPath,
        ),
      `Transferred files to Drive ${targetAccount.label}.`,
      {
        clearSelection: true,
        job: {
          kind: 'transfer',
          label:
            selectedFiles.length === 1
              ? `Transfer ${selectedFiles[0]?.filename ?? 'file'}`
              : `Transfer ${selectedFiles.length} files`,
          sourceAccountId: selectedFiles[0]?.accountId,
          targetAccountId: targetAccount.accountId,
        },
      },
    );
  }

  async function handleDeleteDuplicateNodes(nodes: UnifiedNode[]) {
    if (nodes.length === 0) {
      return;
    }

    const driveNodes = nodes.filter((node) => {
      const account = driveState.accounts.find((item) => item.accountId === node.accountId);
      return account?.sourceKind === 'drive';
    });
    if (driveNodes.length !== nodes.length) {
      setErrorMessage('Duplicate cleanup delete is only available for Google Drive files.');
      return;
    }

    const reclaimableBytes = duplicateSelectionBytes(driveNodes);
    const confirmed = window.confirm(
      `Delete ${driveNodes.length} duplicate files and reclaim ${humanizeBytes(reclaimableBytes)}?`,
    );
    if (!confirmed) {
      return;
    }

    await runMutation(
      async () => {
        for (const node of driveNodes) {
          await deleteDriveNode(node.accountId, node.googleId);
        }
      },
      'Duplicate files deleted.',
      {
        clearSelection: true,
        job: {
          kind: 'delete',
          label:
            driveNodes.length === 1
              ? `Delete duplicate ${driveNodes[0]?.filename ?? 'file'}`
              : `Delete ${driveNodes.length} duplicate files`,
          sourceAccountId: driveNodes[0]?.accountId,
        },
      },
    );
  }

  async function handleTransferDuplicateNodes(nodes: UnifiedNode[]) {
    if (nodes.length === 0) {
      return;
    }

    const driveNodes = nodes.filter((node) => {
      const account = driveState.accounts.find((item) => item.accountId === node.accountId);
      return account?.sourceKind === 'drive';
    });
    if (driveNodes.length !== nodes.length) {
      setErrorMessage('Duplicate cleanup transfer is only available for Google Drive files.');
      return;
    }

    const targetAccounts = driveState.accounts.filter((account) => {
      if (account.sourceKind !== 'drive' || !account.isConnected) {
        return false;
      }

      return driveNodes.some((node) => node.accountId !== account.accountId);
    });
    if (targetAccounts.length === 0) {
      setErrorMessage('Connect another Google Drive account before transferring duplicate files.');
      return;
    }

    const targetPrompt = targetAccounts
      .map((account) => `${account.label}: ${account.displayName}`)
      .join('\n');
    const targetLabel = window.prompt(
      `Transfer selected duplicates to which drive?\n${targetPrompt}`,
      targetAccounts[0]?.label ?? '',
    );
    if (!targetLabel) {
      return;
    }

    const normalizedTarget = targetLabel.trim().toLowerCase();
    const targetAccount = targetAccounts.find(
      (account) =>
        account.label.toLowerCase() === normalizedTarget ||
        account.displayName.toLowerCase() === normalizedTarget ||
        account.email?.toLowerCase() === normalizedTarget,
    );
    if (!targetAccount) {
      setErrorMessage('That target drive was not found. Use the drive label shown in the prompt.');
      return;
    }

    await runMutation(
      () =>
        transferDriveNodes(
          driveNodes.map((node) => nodeToHandle(node)),
          targetAccount.accountId,
          route.folderPath,
        ),
      `Transferred duplicate files to Drive ${targetAccount.label}.`,
      {
        clearSelection: true,
        job: {
          kind: 'transfer',
          label:
            driveNodes.length === 1
              ? `Transfer duplicate ${driveNodes[0]?.filename ?? 'file'}`
              : `Transfer ${driveNodes.length} duplicate files`,
          sourceAccountId: driveNodes[0]?.accountId,
          targetAccountId: targetAccount.accountId,
        },
      },
    );
  }

  function handleJumpToDuplicateNodes(nodes: UnifiedNode[]) {
    if (nodes.length === 0) {
      return;
    }

    const firstNode = nodes[0];
    const accountIds = [...new Set(nodes.map((node) => node.accountId))];
    const nextScope: BrowseScope =
      accountIds.length === 1 ? { kind: 'account', accountId: accountIds[0] } : { kind: 'all' };

    setIsSelectMode(false);
    setSelectedRowIds(nodes.map((node) => node.id));
    navigate({
      view: 'browse',
      scope: nextScope,
      category: 'all',
      folderPath: parentFolderPath(firstNode.virtualPath),
    });
  }

  async function handleShareSelected() {
    if (!selectedFile || selectedAccount?.sourceKind !== 'drive') {
      setErrorMessage('Sharing is only available for a single Google Drive file.');
      return;
    }

    const emailAddress = window.prompt('Share with email address');
    if (!emailAddress?.trim()) {
      return;
    }

    const roleInput = window.prompt(
      'Permission role: reader, commenter, or writer',
      'reader',
    );
    if (!roleInput) {
      return;
    }

    const normalizedRole = roleInput.trim().toLowerCase();
    if (!['reader', 'commenter', 'writer'].includes(normalizedRole)) {
      setErrorMessage('Use one of these sharing roles: reader, commenter, or writer.');
      return;
    }

    await runMutation(
      () =>
        shareDriveNode(
          nodeToHandle(selectedFile),
          emailAddress.trim(),
          normalizedRole as ShareRole,
        ),
      `Shared ${selectedFile.filename} with ${emailAddress.trim()}.`,
      { refresh: false },
    );
  }

  async function handleShowRevisions() {
    if (!selectedFile || selectedAccount?.sourceKind !== 'drive') {
      setErrorMessage('Revision history is only available for a single Google Drive file.');
      return;
    }

    setRevisionPanel({
      node: selectedFile,
      revisions: [],
      isLoading: true,
      errorMessage: null,
    });

    try {
      const revisions = await listDriveRevisions(nodeToHandle(selectedFile));
      setRevisionPanel({
        node: selectedFile,
        revisions,
        isLoading: false,
        errorMessage: null,
      });
    } catch (error) {
      setRevisionPanel({
        node: selectedFile,
        revisions: [],
        isLoading: false,
        errorMessage: toUserFacingErrorMessage(error, 'OmniDrive could not load revision history.'),
      });
    }
  }

  async function handleCopySelectedPath() {
    const pathToCopy = selectedRow?.virtualPath ?? previewNode?.virtualPath;
    if (!pathToCopy) {
      return;
    }

    try {
      await navigator.clipboard.writeText(pathToCopy);
      setNoticeMessage(`Copied path: ${pathToCopy}`);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, 'OmniDrive could not copy that path.'));
    }
  }

  async function handleRenameRow(row: BrowseRow) {
    if (row.entry.kind === 'file') {
      const selectedFile = row.entry.node;
      const nextName = window.prompt('Rename file', selectedFile.filename);
      if (!nextName || nextName === selectedFile.filename) {
        return;
      }

      await runMutation(
        () => renameDriveNode(selectedFile.accountId, selectedFile.googleId, nextName),
        'File renamed.',
        {
          clearSelection: true,
          job: {
            kind: 'rename',
            label: `Rename ${selectedFile.filename}`,
            sourceAccountId: selectedFile.accountId,
          },
        },
      );
      return;
    }

    if (row.virtualPath === '/') {
      return;
    }

    const nextName = window.prompt('Rename folder', row.name);
    if (!nextName || nextName === row.name) {
      return;
    }

    await runMutation(
      () => renameVirtualFolder(row.virtualPath, nextName),
      'Folder renamed across OmniDrive.',
      {
        clearSelection: true,
        job: { kind: 'rename', label: `Rename folder ${row.name}` },
      },
    );
  }

  async function handleDeleteRow(row: BrowseRow) {
    if (!isRowDeletable(row)) {
      setErrorMessage('Delete is only available for Google Drive files and non-root virtual folders.');
      return;
    }

    if (row.entry.kind === 'file') {
      const selectedFile = row.entry.node;
      const confirmed = window.confirm(`Delete ${row.name} from Google Drive?`);
      if (!confirmed) {
        return;
      }

      await runMutation(
        () => deleteDriveNode(selectedFile.accountId, selectedFile.googleId),
        'File deleted.',
        {
          clearSelection: true,
          job: {
            kind: 'delete',
            label: `Delete ${selectedFile.filename}`,
            sourceAccountId: selectedFile.accountId,
          },
        },
      );
      return;
    }

    const confirmed = window.confirm(
      `Delete the virtual folder ${row.virtualPath} from every backing account?`,
    );
    if (!confirmed) {
      return;
    }

    await runMutation(
      () => deleteVirtualFolder(row.virtualPath),
      'Folder deleted from all backing accounts.',
      {
        clearSelection: true,
        job: { kind: 'delete', label: `Delete folder ${row.name}` },
      },
    );
  }

  async function handleDownloadRow(row: BrowseRow) {
    const fileHandle = rowToHandle(row);
    if (!fileHandle) {
      return;
    }

    await runMutation(
      () => downloadDriveNode(fileHandle),
      'Downloaded to',
      {
        refresh: false,
        job: {
          kind: 'download',
          label: `Download ${fileHandle.filename}`,
          sourceAccountId: fileHandle.accountId,
        },
      },
    );
  }

  async function handleShareRow(row: BrowseRow) {
    if (!isFileBrowseRow(row) || accountForRow(row)?.sourceKind !== 'drive') {
      setErrorMessage('Sharing is only available for Google Drive files.');
      return;
    }

    const emailAddress = window.prompt('Share with email address');
    if (!emailAddress?.trim()) {
      return;
    }

    const roleInput = window.prompt(
      'Permission role: reader, commenter, or writer',
      'reader',
    );
    if (!roleInput) {
      return;
    }

    const normalizedRole = roleInput.trim().toLowerCase();
    if (!['reader', 'commenter', 'writer'].includes(normalizedRole)) {
      setErrorMessage('Use one of these sharing roles: reader, commenter, or writer.');
      return;
    }

    await runMutation(
      () =>
        shareDriveNode(
          nodeToHandle(row.entry.node),
          emailAddress.trim(),
          normalizedRole as ShareRole,
        ),
      `Shared ${row.entry.node.filename} with ${emailAddress.trim()}.`,
      { refresh: false },
    );
  }

  async function handleShowRowRevisions(row: BrowseRow) {
    if (!isFileBrowseRow(row) || accountForRow(row)?.sourceKind !== 'drive') {
      setErrorMessage('Revision history is only available for Google Drive files.');
      return;
    }

    setRevisionPanel({
      node: row.entry.node,
      revisions: [],
      isLoading: true,
      errorMessage: null,
    });

    try {
      const revisions = await listDriveRevisions(nodeToHandle(row.entry.node));
      setRevisionPanel({
        node: row.entry.node,
        revisions,
        isLoading: false,
        errorMessage: null,
      });
    } catch (error) {
      setRevisionPanel({
        node: row.entry.node,
        revisions: [],
        isLoading: false,
        errorMessage: toUserFacingErrorMessage(error, 'OmniDrive could not load revision history.'),
      });
    }
  }

  async function handleCopyRowPath(row: BrowseRow) {
    try {
      await navigator.clipboard.writeText(row.virtualPath);
      setNoticeMessage(`Copied path: ${row.virtualPath}`);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(toUserFacingErrorMessage(error, 'OmniDrive could not copy that path.'));
    }
  }

  async function handleCancelJob(jobId: string) {
    await runMutation(() => cancelDriveJob(jobId), 'Job cancelled.', { refresh: false });
  }

  async function handleDisconnectAccount(accountId: string, label: string) {
    const confirmed = window.confirm(
      `Disconnect Drive ${label}? OmniDrive will remove the stored refresh token for this account.`,
    );
    if (!confirmed) {
      return;
    }

    await runMutation(
      () => disconnectGoogleAccount(accountId),
      `Disconnected Drive ${label}.`,
      { clearSelection: true },
    );
  }

  function openBrowseRowDirect(row: BrowseRow) {
    setSelectedRowIds([row.id]);
    if (row.entry.kind === 'directory') {
      navigate({
        view: 'browse',
        scope: route.scope,
        category: route.category,
        folderPath: row.virtualPath,
      });
      return;
    }

    const fileNode = row.entry.node;
    navigate({
      view: 'preview',
      scope: route.scope,
      category: route.category,
      folderPath: route.folderPath,
      nodeId: fileNode.id,
    });
  }

  function openBrowseRow(row: BrowseRow) {
    setContextMenu(null);
    if (isSelectMode) {
      toggleBrowseRowSelection(row);
      return;
    }

    openBrowseRowDirect(row);
  }

  function toggleBrowseRowSelection(row: BrowseRow) {
    setSelectedRowIds((current) =>
      current.includes(row.id)
        ? current.filter((id) => id !== row.id)
        : [...current, row.id],
    );
  }

  function handleBrowseRowPress(row: BrowseRow) {
    setContextMenu(null);
    if (isSelectMode) {
      toggleBrowseRowSelection(row);
      return;
    }

    setSelectedRowIds([row.id]);
  }

  function openBrowseRowContextMenu(
    row: BrowseRow,
    position: { x: number; y: number },
  ) {
    const menuWidth = 240;
    const viewportPadding = 12;
    const nextX = Math.min(
      Math.max(viewportPadding, position.x),
      window.innerWidth - menuWidth - viewportPadding,
    );
    const nextY = Math.max(viewportPadding, position.y);

    setSelectedRowIds([row.id]);
    setIsSelectMode(false);
    setContextMenu({
      row,
      x: nextX,
      y: nextY,
    });
  }

  function enterSelectMode() {
    setIsSelectMode(true);
    setSelectedRowIds([]);
  }

  function exitSelectMode() {
    setIsSelectMode(false);
    setSelectedRowIds([]);
  }

  const selectedFile =
    selectedRow?.entry.kind === 'file' ? selectedRow.entry.node : null;
  const selectedDriveFiles = selectedRows
    .filter(isFileBrowseRow)
    .map((row) => row.entry.node)
    .filter((node) => {
      const account = driveState.accounts.find((item) => item.accountId === node.accountId);
      return account?.sourceKind === 'drive';
    });
  const selectedPreviewable = Boolean(selectedFile?.isPreviewable);
  const selectedAccount = selectedFile
    ? driveState.accounts.find((account) => account.accountId === selectedFile.accountId) ?? null
    : null;
  const canRenameSelected =
    selectedRows.length === 1 &&
    Boolean(
      selectedRow?.entry.kind === 'directory'
        ? selectedRow.virtualPath !== '/'
        : selectedAccount?.sourceKind === 'drive',
    );
  const canDeleteSelected = selectedRows.length > 0 && selectedRows.every(isRowDeletable);
  const canTransferSelected =
    selectedRows.length > 0 && selectedDriveFiles.length === selectedRows.length;
  const canShareSelected = Boolean(selectedFile && selectedAccount?.sourceKind === 'drive');
  const canShowRevisions = canShareSelected;
  const actionDisabled = driveState.requiresDesktopShell || isLoading || isMutating;
  const emptyBrowseMessage = preferences.filters.searchQuery.trim()
    ? `No files matched "${preferences.filters.searchQuery.trim()}".`
    : 'No files are available in this view yet.';
  const scopeStatusMessage = driveState.requiresDesktopShell
    ? 'Desktop shell required: open OmniDrive through Tauri to sign in and use live Drive actions.'
    : isLoading
      ? 'Loading live Google Drive quota and file listings.'
      : visibleLoadErrors[0] ??
        `${humanizeBytes(summary.free)} free across the currently visible drives.`;

  if (authStatus !== 'ready' || !authSession) {
    return (
      <AuthShell
        isLoading={authStatus === 'loading'}
        mode={authScreenMode}
        pendingEmail={authPendingEmail}
        errorMessage={authErrorMessage}
        noticeMessage={authNoticeMessage}
        isSubmitting={isAuthSubmitting}
        turnstileSiteKey={turnstileSiteKey}
        onSwitchMode={(mode) => {
          setAuthErrorMessage(null);
          setAuthNoticeMessage(null);
          setAuthScreenMode(mode);
        }}
        onSignIn={(email, password, captchaToken) => {
          void handleAuthSignIn(email, password, captchaToken);
        }}
        onSignUp={(email, password, captchaToken) => {
          void handleAuthSignUp(email, password, captchaToken);
        }}
        onGoogleSignIn={(captchaToken) => {
          void handleGoogleSignIn(captchaToken);
        }}
        onSignOut={() => {
          void handleLockedSignOut();
        }}
        onVerifyEmailCheck={() => {
          void handleVerifyEmailCheck();
        }}
        onPasswordReset={(email, captchaToken) => {
          void handlePasswordReset(email, captchaToken);
        }}
        onResendVerification={() => {
          void handleResendVerification();
        }}
      />
    );
  }

  return (
    <main
      data-theme={themeMode}
      data-theme-variant={themeVariant}
      className="theme-root relative flex h-screen flex-col overflow-hidden text-slate-100"
    >
      <WindowTitleBar />
      <div className="page-backdrop" />
      <div className="relative z-10 grid h-[calc(100vh-2.75rem)] w-full grid-cols-[236px,minmax(0,1fr)]">
        <DriveSidebar
          accounts={driveState.accounts}
          activeScope={route.scope}
          activeCategory={route.category}
          disabled={actionDisabled}
          isConnecting={isConnecting}
          onSelectScope={(scope) => {
            setSelectedRowIds([]);
            setIsSelectMode(false);
            navigate({ view: 'browse', scope, category: 'all', folderPath: '/' });
          }}
          onSelectCategory={(category) => {
            setSelectedRowIds([]);
            setIsSelectMode(false);
            navigate({ view: 'browse', scope: route.scope, category, folderPath: '/' });
          }}
          onConnectAccount={() => {
            void handleConnectGoogleAccount();
          }}
          onConnectPhotosAccount={() => {
            void handleConnectGooglePhotosAccount();
          }}
          onDisconnectAccount={(accountId, label) => {
            void handleDisconnectAccount(accountId, label);
          }}
        />

        <section className="flex h-[calc(100vh-2.75rem)] min-w-0 flex-col overflow-hidden">
          <header className="z-20 bg-[#061426]/92 px-5 py-3 shadow-[0_14px_34px_rgba(0,0,0,0.18)] backdrop-blur-2xl">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-400">
                  <span>My Files</span>
                  {breadcrumbs.map((item, index) => (
                    <button
                      key={`${item.label}:${item.folderPath}`}
                      type="button"
                      onClick={() =>
                        navigate({
                          view: 'browse',
                          scope: route.scope,
                          category: item.category,
                          folderPath: item.folderPath,
                        })
                      }
                      className={[
                        'inline-flex items-center gap-2 transition hover:text-cyan-100',
                        index === breadcrumbs.length - 1 ? 'text-slate-200' : 'text-slate-500',
                      ].join(' ')}
                    >
                      <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
                      <span className="max-w-[12rem] truncate">{item.label}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {scopeLabel(route.scope, driveState.accounts)}
                  {route.category !== 'all' ? ` / ${CATEGORY_LABELS[route.category]}` : ''} · {currentDescription}
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <div ref={accountMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setIsAccountMenuOpen((current) => !current)}
                    className="inline-flex items-center gap-2 rounded-full border border-cyan-100/10 bg-slate-950/45 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.05]"
                  >
                    <Mail className="h-4 w-4 text-cyan-200" />
                    <span className="max-w-[12rem] truncate">{authSession.user.email}</span>
                    <ArrowDown className="h-3.5 w-3.5 text-slate-500" />
                  </button>
                  {isAccountMenuOpen ? (
                    <div className="absolute right-0 top-[calc(100%+0.5rem)] z-30 min-w-[220px] rounded-2xl border border-cyan-100/10 bg-[#071527]/96 p-2 shadow-[0_20px_50px_rgba(0,0,0,0.32)] backdrop-blur-2xl">
                      <div className="border-b border-cyan-100/[0.06] px-3 py-2">
                        <p className="truncate text-sm font-semibold text-slate-100">{authSession.user.email}</p>
                        <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-cyan-200">
                          Verified account
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void handleSignOut();
                        }}
                        className="mt-2 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-200 transition hover:bg-white/[0.05] hover:text-cyan-100"
                      >
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.045] text-slate-300">
                          <LogOut className="h-4 w-4" />
                        </span>
                        Sign out
                      </button>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void handleSignOut();
                  }}
                  className="glass-icon-button"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut className="h-5 w-5" />
                </button>
                <div className="hidden items-center gap-2 rounded-full border border-cyan-100/10 bg-slate-950/45 px-3 py-1.5 text-xs text-slate-400 2xl:flex">
                  <span>{humanizeBytes(summary.used)} used</span>
                  <span className="text-slate-600">/</span>
                  <span>{humanizeBytes(summary.free)} free</span>
                </div>
                <button
                  type="button"
                  onClick={() => setIsCommandPaletteOpen(true)}
                  className="glass-icon-button"
                  aria-label="Open command palette"
                  title="Command palette"
                >
                  <Command className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  className="glass-icon-button"
                  aria-label="Open settings"
                  title="Settings"
                >
                  <Settings className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleUploadFile();
                  }}
                  disabled={actionDisabled}
                  className="inline-flex items-center gap-2 rounded-md bg-cyan-500 px-3 py-2 text-xs font-bold text-slate-950 transition hover:bg-cyan-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Upload className="h-4 w-4" />
                  Upload
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-2 pt-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm text-slate-400">{scopeStatusMessage}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void handleSyncVisibleScope();
                  }}
                  disabled={actionDisabled}
                  className="inline-flex items-center gap-2 rounded-md border border-cyan-100/15 bg-slate-900/70 px-3 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-white/5 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RefreshCcw className="h-4 w-4" />
                  {isLoading ? 'Refreshing...' : 'Refresh Index'}
                </button>
                <div className="luxury-toggle-group inline-flex items-center rounded-md border border-cyan-100/10 bg-slate-950/45 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl">
                  <ViewModeButton
                    active={viewMode === 'list'}
                    icon={<List className="h-4 w-4" />}
                    label="List view"
                    onClick={() => setViewMode('list')}
                  />
                  <ViewModeButton
                    active={viewMode === 'grid'}
                    icon={<LayoutGrid className="h-4 w-4" />}
                    label="Grid view"
                    onClick={() => setViewMode('grid')}
                  />
                </div>
              </div>
            </div>

            {errorMessage ? (
              <div className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {errorMessage}
              </div>
            ) : null}

            {noticeMessage ? (
              <div className="mt-4 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                {noticeMessage}
              </div>
            ) : null}
          </header>

          {isSettingsOpen ? (
            <SettingsPanel
              settings={appSettings}
              onSettingsChange={(settings) => {
                void persistAppSettings(settings);
              }}
              onClearPreviewCache={() => {
                void runMutation(() => clearPreviewCache(), 'Preview cache cleared.', {
                  refresh: false,
                });
              }}
              onClose={() => setIsSettingsOpen(false)}
            />
          ) : null}

          {isCommandPaletteOpen ? (
            <CommandPalette
              onClose={() => setIsCommandPaletteOpen(false)}
              onRefresh={() => {
                setIsCommandPaletteOpen(false);
                void refreshDriveState();
              }}
              onSyncVisibleScope={() => {
                setIsCommandPaletteOpen(false);
                void handleSyncVisibleScope();
              }}
              onUpload={() => {
                setIsCommandPaletteOpen(false);
                void handleUploadFile();
              }}
              onCreateFolder={() => {
                setIsCommandPaletteOpen(false);
                void handleCreateFolder();
              }}
              onOpenSettings={() => {
                setIsCommandPaletteOpen(false);
                setIsSettingsOpen(true);
              }}
              onEnterSelectMode={() => {
                setIsCommandPaletteOpen(false);
                enterSelectMode();
              }}
            />
          ) : null}

          {revisionPanel ? (
            <RevisionsPanel
              panel={revisionPanel}
              onClose={() => setRevisionPanel(null)}
            />
          ) : null}

          {contextMenu ? (
            <RowContextMenu
              menuRef={contextMenuRef}
              row={contextMenu.row}
              x={contextMenu.x}
              y={contextMenu.y}
              account={accountForRow(contextMenu.row)}
              onClose={() => setContextMenu(null)}
              onOpen={() => {
                setContextMenu(null);
                openBrowseRowDirect(contextMenu.row);
              }}
              onUploadInto={() => {
                setContextMenu(null);
                void handleUploadIntoFolder(contextMenu.row.virtualPath);
              }}
              onCreateInside={() => {
                setContextMenu(null);
                void handleCreateFolderIn(contextMenu.row.virtualPath);
              }}
              onRename={() => {
                setContextMenu(null);
                void handleRenameRow(contextMenu.row);
              }}
              onDelete={() => {
                setContextMenu(null);
                void handleDeleteRow(contextMenu.row);
              }}
              onDownload={() => {
                setContextMenu(null);
                void handleDownloadRow(contextMenu.row);
              }}
              onShare={() => {
                setContextMenu(null);
                void handleShareRow(contextMenu.row);
              }}
              onShowRevisions={() => {
                setContextMenu(null);
                void handleShowRowRevisions(contextMenu.row);
              }}
              onCopyPath={() => {
                setContextMenu(null);
                void handleCopyRowPath(contextMenu.row);
              }}
            />
          ) : null}

          {!appSettings.hasCompletedFirstRun ? (
            <FirstRunSetup
              onComplete={() => {
                void persistAppSettings({
                  ...appSettings,
                  hasCompletedFirstRun: true,
                });
              }}
            />
          ) : null}

          {route.view === 'preview' && previewNode ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <FilePreview
                node={previewNode}
                descriptor={previewDescriptor}
                isLoading={isPreviewLoading}
                errorMessage={previewError}
                onBack={() =>
                  navigate({
                    view: 'browse',
                    scope: route.scope,
                    category: route.category,
                    folderPath: route.folderPath,
                  })
                }
                onDownload={() => {
                  void handleDownloadSelected();
                }}
              />
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 overflow-hidden bg-[#031426]">
              <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
                <BrowseToolbar
                  filters={preferences.filters}
                  sort={preferences.sort}
                  viewMode={viewMode}
                  isSelectMode={isSelectMode}
                  selectedRow={selectedRow}
                  selectedCount={selectedRows.length}
                  disabled={actionDisabled}
                  gridCardSize={appSettings.gridCardSize}
                  onSearchChange={(searchQuery) =>
                    updatePreferences((current) => ({
                      ...current,
                      filters: { ...current.filters, searchQuery },
                    }))
                  }
                  onEntryKindChange={(entryKind) =>
                    updatePreferences((current) => ({
                      ...current,
                      filters: { ...current.filters, entryKind },
                    }))
                  }
                  onSortFieldChange={(field) =>
                    updatePreferences((current) => ({
                      ...current,
                      sort: {
                        ...current.sort,
                        field,
                      },
                    }))
                  }
                  onToggleSortDirection={() =>
                    updatePreferences((current) => ({
                      ...current,
                      sort: {
                        ...current.sort,
                        direction: current.sort.direction === 'asc' ? 'desc' : 'asc',
                      },
                    }))
                  }
                  onGridCardSizeChange={(value) => {
                    setAppSettings((current) => ({
                      ...current,
                      gridCardSize: clampGridCardSize(value),
                    }));
                  }}
                  onGridCardSizeCommit={(value) => {
                    const nextGridCardSize = clampGridCardSize(value);
                    void persistAppSettings({
                      ...appSettings,
                      gridCardSize: nextGridCardSize,
                    });
                  }}
                  onEnterSelectMode={enterSelectMode}
                  onExitSelectMode={exitSelectMode}
                  onOpenPreview={() => {
                    if (!selectedRow || selectedRow.entry.kind !== 'file') {
                      return;
                    }
                    navigate({
                      view: 'preview',
                      scope: route.scope,
                      category: route.category,
                      folderPath: route.folderPath,
                      nodeId: selectedRow.entry.node.id,
                    });
                  }}
                  onUpload={() => {
                    void handleUploadFile();
                  }}
                  onCreateFolder={() => {
                    void handleCreateFolder();
                  }}
                  onRename={() => {
                    void handleRenameSelection();
                  }}
                  onDelete={() => {
                    void handleDeleteSelection();
                  }}
                  onDownload={() => {
                    void handleDownloadSelected();
                  }}
                  onTransfer={() => {
                    void handleTransferSelected();
                  }}
                  canPreview={Boolean(selectedPreviewable)}
                  canRenameSelected={canRenameSelected}
                  canDeleteSelected={canDeleteSelected}
                  canTransferSelected={canTransferSelected}
                />

                <PracticalityStrip
                  disabled={actionDisabled}
                  jobs={driveJobs}
                  insights={storageInsights}
                  nodes={driveState.nodes}
                  accounts={driveState.accounts}
                  duplicateGroups={duplicateGroups}
                  onRefresh={() => {
                    void refreshLocalFoundation();
                  }}
                  onCancelJob={(jobId) => {
                    void handleCancelJob(jobId);
                  }}
                  onJumpToDuplicateNodes={(nodes) => {
                    handleJumpToDuplicateNodes(nodes);
                  }}
                  onDeleteDuplicateNodes={(nodes) => {
                    void handleDeleteDuplicateNodes(nodes);
                  }}
                  onTransferDuplicateNodes={(nodes) => {
                    void handleTransferDuplicateNodes(nodes);
                  }}
                />

                <div className="mt-4 overflow-hidden rounded-[8px] bg-[#041322]/40">
                  {viewMode === 'grid' ? (
                    <DriveGrid
                      rows={browseRows}
                      selectedRowIds={selectedRowIds}
                      isSelectMode={isSelectMode}
                      thumbnails={gridThumbnails}
                      gridCardSize={appSettings.gridCardSize}
                      themeMode={themeMode}
                      themeVariant={themeVariant}
                      emptyMessage={emptyBrowseMessage}
                      onSelectRow={handleBrowseRowPress}
                      onOpenRow={openBrowseRow}
                      onContextMenu={openBrowseRowContextMenu}
                    />
                  ) : (
                    <DriveTable
                      rows={browseRows}
                      selectedRowIds={selectedRowIds}
                      isSelectMode={isSelectMode}
                      sort={preferences.sort}
                      emptyMessage={emptyBrowseMessage}
                      thumbnails={gridThumbnails}
                      themeMode={themeMode}
                      themeVariant={themeVariant}
                      onSortChange={(field) => {
                        updatePreferences((current) => ({
                          ...current,
                          sort: {
                            field,
                            direction:
                              current.sort.field === field && current.sort.direction === 'asc'
                                ? 'desc'
                                : 'asc',
                          },
                        }));
                      }}
                      onSelectRow={handleBrowseRowPress}
                      onOpenRow={openBrowseRow}
                      onContextMenu={openBrowseRowContextMenu}
                    />
                  )}
                </div>
              </div>

              {selectedRow?.entry.kind === 'file' ? (
                <SelectionDetailsPanel
                  selectedRow={selectedRow}
                  onDownload={() => {
                    void handleDownloadSelected();
                  }}
                  onShare={() => {
                    void handleShareSelected();
                  }}
                  onDelete={() => {
                    void handleDeleteSelection();
                  }}
                  canDownload
                  canShare={canShareSelected}
                  disabled={actionDisabled}
                />
              ) : null}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function AuthShell({
  isLoading,
  mode,
  pendingEmail,
  errorMessage,
  noticeMessage,
  isSubmitting,
  turnstileSiteKey,
  onSwitchMode,
  onSignIn,
  onSignUp,
  onGoogleSignIn,
  onSignOut,
  onVerifyEmailCheck,
  onPasswordReset,
  onResendVerification,
}: {
  isLoading: boolean;
  mode: AuthScreenMode;
  pendingEmail: string;
  errorMessage: string | null;
  noticeMessage: string | null;
  isSubmitting: boolean;
  turnstileSiteKey: string;
  onSwitchMode: (mode: AuthShellMode) => void;
  onSignIn: (email: string, password: string, captchaToken?: string) => void;
  onSignUp: (email: string, password: string, captchaToken?: string) => void;
  onGoogleSignIn: (captchaToken?: string) => void;
  onSignOut: () => void;
  onVerifyEmailCheck: () => void;
  onPasswordReset: (email: string, captchaToken?: string) => void;
  onResendVerification: () => void;
}) {
  const [email, setEmail] = useState(pendingEmail);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [localErrorMessage, setLocalErrorMessage] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState('');
  const captchaContainerRef = useRef<HTMLDivElement>(null);
  const captchaWidgetIdRef = useRef<string | null>(null);
  const captchaRequired = mode !== 'verifyEmail' && Boolean(turnstileSiteKey);

  useEffect(() => {
    if (pendingEmail) {
      setEmail(pendingEmail);
    }
  }, [pendingEmail]);

  useEffect(() => {
    setLocalErrorMessage(null);
    setPassword('');
    setConfirmPassword('');
    setCaptchaToken('');
  }, [mode]);

  useEffect(() => {
    if (!captchaRequired || !captchaContainerRef.current) {
      return undefined;
    }

    const container = captchaContainerRef.current;
    let cancelled = false;

    const renderCaptcha = () => {
      if (cancelled || captchaWidgetIdRef.current || !container || !window.turnstile) {
        return;
      }

      captchaWidgetIdRef.current = window.turnstile.render(container, {
        sitekey: turnstileSiteKey,
        theme: 'dark',
        callback: (token) => {
          setCaptchaToken(token);
          setLocalErrorMessage(null);
        },
        'expired-callback': () => {
          setCaptchaToken('');
        },
        'error-callback': () => {
          setCaptchaToken('');
          setLocalErrorMessage('Security check could not load. Try again in a moment.');
        },
      });
    };

    if (window.turnstile) {
      renderCaptcha();
    } else {
      const scriptId = 'omnidrive-turnstile-script';
      const existingScript = document.getElementById(scriptId) as HTMLScriptElement | null;
      const script = existingScript ?? document.createElement('script');
      script.id = scriptId;
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.addEventListener('load', renderCaptcha, { once: true });
      if (!existingScript) {
        document.head.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      if (captchaWidgetIdRef.current && window.turnstile?.remove) {
        window.turnstile.remove(captchaWidgetIdRef.current);
      }
      captchaWidgetIdRef.current = null;
    };
  }, [captchaRequired, turnstileSiteKey]);

  const title =
    mode === 'signUp'
      ? 'Create your OmniDrive account'
      : mode === 'forgotPassword'
        ? 'Reset your OmniDrive password'
        : mode === 'verifyEmail'
          ? 'Verify your email'
          : 'Sign in to OmniDrive';
  const subtitle =
    mode === 'signUp'
      ? 'Use your own OmniDrive account before any linked Google drives become visible on this device.'
      : mode === 'forgotPassword'
        ? 'We will send a reset link through Supabase so you can get back into the workspace.'
        : mode === 'verifyEmail'
          ? 'Email verification is required before the desktop workspace unlocks.'
          : 'Your Google accounts, local index, and preview cache stay hidden until you authenticate.';

  return (
    <main className="theme-root relative flex h-screen flex-col overflow-hidden bg-[#03111d] text-slate-100">
      <WindowTitleBar />
      <div className="page-backdrop" />
      <div className="relative z-10 flex h-[calc(100vh-2.75rem)] items-center justify-center px-6">
        <section className="glass-panel w-full max-w-[440px] rounded-[28px] border border-cyan-100/10 bg-[#071527]/88 p-7 shadow-[0_30px_80px_rgba(0,0,0,0.32)] backdrop-blur-2xl">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-300/15 bg-cyan-400/10 text-cyan-200">
            {mode === 'forgotPassword' ? (
              <Mail className="h-5 w-5" />
            ) : (
              <LockKeyhole className="h-5 w-5" />
            )}
          </div>
          <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200">
            OmniDrive Access
          </p>
          <h1 className="mt-3 font-display text-3xl font-semibold text-slate-100">{title}</h1>
          <p className="mt-3 text-sm leading-6 text-slate-400">{subtitle}</p>

          {errorMessage ? (
            <div className="mt-5 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {errorMessage}
            </div>
          ) : null}

          {localErrorMessage ? (
            <div className="mt-5 rounded-2xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100">
              {localErrorMessage}
            </div>
          ) : null}

          {noticeMessage ? (
            <div className="mt-5 rounded-2xl border border-cyan-300/25 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-100">
              {noticeMessage}
            </div>
          ) : null}

          {captchaRequired ? (
            <div className="mt-5 rounded-2xl border border-cyan-100/10 bg-white/[0.035] px-4 py-4">
              <div className="min-h-[65px]" ref={captchaContainerRef} />
            </div>
          ) : null}

          {mode === 'verifyEmail' ? (
            <div className="mt-6 space-y-4">
              <div className="rounded-2xl border border-cyan-100/10 bg-white/[0.035] px-4 py-4">
                <p className="text-sm font-semibold text-slate-100">{pendingEmail || 'Your inbox'}</p>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  Open the verification link from Supabase, then come back and sign in here.
                </p>
              </div>
              <button
                type="button"
                onClick={onResendVerification}
                disabled={isSubmitting || !pendingEmail}
                className="w-full rounded-full bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? 'Sending...' : 'Resend verification email'}
              </button>
              <button
                type="button"
                onClick={() => onSwitchMode('signIn')}
                className="w-full rounded-full border border-cyan-100/10 bg-white/[0.03] px-4 py-3 text-sm font-semibold text-slate-200 transition hover:bg-white/[0.05]"
              >
                Back to sign in
              </button>
              <button
                type="button"
                onClick={onSignOut}
                disabled={isSubmitting}
                className="w-full rounded-full border border-red-300/15 bg-red-400/10 px-4 py-3 text-sm font-semibold text-red-100 transition hover:bg-red-400/15 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Use another account
              </button>
            </div>
          ) : (
            <div className="mt-6">
              {mode !== 'forgotPassword' ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      if (captchaRequired && !captchaToken) {
                        setLocalErrorMessage('Please complete the security check.');
                        return;
                      }
                      onGoogleSignIn(captchaToken || undefined);
                    }}
                    disabled={isLoading || isSubmitting}
                    className="flex w-full items-center justify-center gap-3 rounded-full border border-cyan-100/10 bg-white/[0.04] px-4 py-3 text-sm font-semibold text-slate-100 transition hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Chrome className="h-4 w-4 text-cyan-200" />
                    Continue with Google
                  </button>
                  <div className="my-5 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-600">
                    <span className="h-px flex-1 bg-cyan-100/10" />
                    Email
                    <span className="h-px flex-1 bg-cyan-100/10" />
                  </div>
                </>
              ) : null}

              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!email.trim()) {
                    return;
                  }

                  if (mode === 'forgotPassword') {
                    if (captchaRequired && !captchaToken) {
                      setLocalErrorMessage('Please complete the security check.');
                      return;
                    }

                    onPasswordReset(email.trim(), captchaToken || undefined);
                    return;
                  }

                  if (mode === 'signUp') {
                    const validationError = validateSignUpForm({
                      email,
                      password,
                      confirmPassword,
                      captchaRequired,
                      captchaToken,
                    });
                    if (validationError) {
                      setLocalErrorMessage(validationError);
                      return;
                    }

                    onSignUp(email.trim(), password, captchaToken || undefined);
                  } else {
                    if (!password.trim()) {
                      return;
                    }

                    if (captchaRequired && !captchaToken) {
                      setLocalErrorMessage('Please complete the security check.');
                      return;
                    }

                    onSignIn(email.trim(), password, captchaToken || undefined);
                  }
                }}
              >
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                    Email
                  </span>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      className="w-full rounded-full border border-cyan-100/10 bg-slate-950/65 px-11 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/30"
                      placeholder="you@example.com"
                      autoComplete="email"
                      disabled={isLoading || isSubmitting}
                    />
                  </div>
                </label>

                {mode !== 'forgotPassword' ? (
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                      Password
                    </span>
                    <div className="relative">
                      <LockKeyhole className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <input
                        type="password"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          if (localErrorMessage) {
                            setLocalErrorMessage(null);
                          }
                        }}
                        className="w-full rounded-full border border-cyan-100/10 bg-slate-950/65 px-11 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/30"
                        placeholder="Password"
                        autoComplete={mode === 'signUp' ? 'new-password' : 'current-password'}
                        disabled={isLoading || isSubmitting}
                      />
                    </div>
                  </label>
                ) : null}

                {mode === 'signUp' ? (
                  <label className="block">
                    <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                      Retype password
                    </span>
                    <div className="relative">
                      <LockKeyhole className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                      <input
                        type="password"
                        value={confirmPassword}
                        onChange={(event) => {
                          setConfirmPassword(event.target.value);
                          if (localErrorMessage === 'Passwords do not match.') {
                            setLocalErrorMessage(null);
                          }
                        }}
                        className="w-full rounded-full border border-cyan-100/10 bg-slate-950/65 px-11 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/30"
                        placeholder="Retype password"
                        autoComplete="new-password"
                        disabled={isLoading || isSubmitting}
                      />
                    </div>
                  </label>
                ) : null}

                <button
                  type="submit"
                  disabled={isLoading || isSubmitting}
                  className="w-full rounded-full bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isLoading
                    ? 'Loading...'
                    : isSubmitting
                      ? 'Working...'
                      : mode === 'signUp'
                        ? 'Create account'
                        : mode === 'forgotPassword'
                          ? 'Send reset email'
                          : 'Sign in'}
                </button>
              </form>
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400">
            {mode === 'signIn' ? (
              <>
                <button
                  type="button"
                  onClick={() => onSwitchMode('forgotPassword')}
                  className="transition hover:text-cyan-100"
                >
                  Forgot password?
                </button>
                <button
                  type="button"
                  onClick={() => onSwitchMode('signUp')}
                  className="transition hover:text-cyan-100"
                >
                  Create account
                </button>
              </>
            ) : mode === 'signUp' ? (
              <button
                type="button"
                onClick={() => onSwitchMode('signIn')}
                className="transition hover:text-cyan-100"
              >
                Already have an account? Sign in
              </button>
            ) : mode === 'forgotPassword' ? (
              <button
                type="button"
                onClick={() => onSwitchMode('signIn')}
                className="transition hover:text-cyan-100"
              >
                Back to sign in
              </button>
            ) : (
              <button
                type="button"
                onClick={onVerifyEmailCheck}
                className="transition hover:text-cyan-100"
              >
                I verified my email
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="soft-border rounded-xl bg-white/[0.035] px-4 py-3 shadow-sm backdrop-blur">
      <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">{label}</p>
      <p className="mt-2 text-sm font-semibold text-slate-100">{value}</p>
    </div>
  );
}

function BrowseToolbar({
  filters,
  sort,
  viewMode,
  isSelectMode,
  selectedRow,
  selectedCount,
  disabled,
  gridCardSize,
  canPreview,
  canRenameSelected,
  canDeleteSelected,
  canTransferSelected,
  onSearchChange,
  onEntryKindChange,
  onSortFieldChange,
  onToggleSortDirection,
  onGridCardSizeChange,
  onGridCardSizeCommit,
  onEnterSelectMode,
  onExitSelectMode,
  onOpenPreview,
  onUpload,
  onCreateFolder,
  onRename,
  onDelete,
  onDownload,
  onTransfer,
}: {
  filters: FilterModel;
  sort: SortModel;
  viewMode: BrowseViewMode;
  isSelectMode: boolean;
  selectedRow: BrowseRow | null;
  selectedCount: number;
  disabled: boolean;
  gridCardSize: number;
  canPreview: boolean;
  canRenameSelected: boolean;
  canDeleteSelected: boolean;
  canTransferSelected: boolean;
  onSearchChange: (value: string) => void;
  onEntryKindChange: (value: FilterModel['entryKind']) => void;
  onSortFieldChange: (value: SortField) => void;
  onToggleSortDirection: () => void;
  onGridCardSizeChange: (value: number) => void;
  onGridCardSizeCommit: (value: number) => void;
  onEnterSelectMode: () => void;
  onExitSelectMode: () => void;
  onOpenPreview: () => void;
  onUpload: () => void;
  onCreateFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onTransfer: () => void;
}) {
  if (isSelectMode) {
    return (
      <section className="rounded-md border border-cyan-100/10 bg-[#061426]/82 p-3 shadow-[0_14px_34px_rgba(0,0,0,0.14)]">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200">
              Select Mode
            </p>
            <p className="mt-2 text-sm text-slate-400">
              {selectedCount > 0 ? `${selectedCount} selected` : 'Choose files or folders to manage.'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <ActionButton
              disabled={disabled || !canRenameSelected}
              icon={<Pencil className="h-4 w-4" />}
              label="Rename"
              onClick={onRename}
            />
            <ActionButton
              disabled={disabled || !canDeleteSelected}
              icon={<Trash2 className="h-4 w-4" />}
              label="Delete"
              onClick={onDelete}
            />
            <ActionButton
              disabled={disabled || !canTransferSelected}
              icon={<ArrowRightLeft className="h-4 w-4" />}
              label="Transfer"
              onClick={onTransfer}
            />
            <ActionButton
              disabled={disabled}
              icon={<X className="h-4 w-4" />}
              label="Cancel"
              onClick={onExitSelectMode}
            />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
            <label className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={filters.searchQuery}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search this drive view..."
                className="w-full min-w-0 rounded-full border border-cyan-100/10 bg-slate-950/45 py-2 pl-10 pr-4 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-300/50 focus:ring-1 focus:ring-cyan-300/30"
              />
            </label>
            <div className="luxury-toggle-group inline-flex h-10 shrink-0 items-center rounded-full border border-cyan-100/10 bg-slate-950/45 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl">
              <ToggleChip
                active={filters.entryKind === 'folders'}
                icon={<FolderOpen className="h-4 w-4" />}
                label="Folders"
                onClick={() =>
                  onEntryKindChange(filters.entryKind === 'folders' ? 'all' : 'folders')
                }
              />
              <ToggleChip
                active={filters.entryKind === 'files'}
                icon={<File className="h-4 w-4" />}
                label="Files"
                onClick={() => onEntryKindChange(filters.entryKind === 'files' ? 'all' : 'files')}
              />
            </div>
            <select
              value={sort.field}
              onChange={(event) => onSortFieldChange(event.target.value as SortField)}
              className="h-10 min-w-[138px] rounded-full border border-cyan-100/10 bg-slate-950/80 px-4 py-2 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50"
            >
              <option value="name">Name</option>
              <option value="modifiedTime">Modified</option>
              <option value="sizeBytes">Size</option>
              <option value="fileCategory">Type</option>
            </select>
            <button
              type="button"
              onClick={onToggleSortDirection}
              aria-label={sort.direction === 'asc' ? 'Ascending sort' : 'Descending sort'}
              title={sort.direction === 'asc' ? 'Ascending sort' : 'Descending sort'}
              className="glass-icon-button h-10 w-10 shrink-0 border-cyan-100/10 bg-slate-950/70 text-slate-200 hover:bg-white/5"
            >
              {sort.direction === 'asc' ? (
                <ArrowUp className="h-4 w-4" />
              ) : (
                <ArrowDown className="h-4 w-4" />
              )}
            </button>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <ActionButton disabled={disabled} icon={<Upload className="h-4 w-4" />} label="Upload" onClick={onUpload} />
            <ActionButton
              disabled={disabled}
              icon={<FolderPlus className="h-4 w-4" />}
              label="New Folder"
              onClick={onCreateFolder}
            />
            <ActionButton
              disabled={disabled}
              icon={<CheckSquare className="h-4 w-4" />}
              label="Select"
              onClick={onEnterSelectMode}
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-cyan-100/10 pt-3 text-sm text-slate-500">
          {viewMode === 'grid' ? (
            <label className="flex min-w-0 items-center gap-3 text-xs uppercase tracking-[0.22em] text-slate-500">
              <span>Grid Size</span>
              <input
                type="range"
                min={MIN_GRID_CARD_SIZE}
                max={MAX_GRID_CARD_SIZE}
                step={10}
                value={gridCardSize}
                onChange={(event) => onGridCardSizeChange(Number(event.target.value))}
                onMouseUp={(event) =>
                  onGridCardSizeCommit(Number((event.target as HTMLInputElement).value))
                }
                onTouchEnd={(event) =>
                  onGridCardSizeCommit(Number((event.target as HTMLInputElement).value))
                }
                onKeyUp={(event) =>
                  onGridCardSizeCommit(Number((event.target as HTMLInputElement).value))
                }
                className="grid-size-slider h-2 w-28 min-w-[7rem] cursor-ew-resize appearance-none rounded-full bg-white/10 sm:w-36"
                aria-label="Adjust grid card size"
              />
            </label>
          ) : null}
          <span className="min-w-0 truncate text-right">
            {selectedCount > 1
              ? `${selectedCount} items selected`
              : selectedRow
              ? `Selected: ${selectedRow.name}`
              : `Select a ${viewMode === 'grid' ? 'card' : 'row'} to rename, delete, or preview it.`}
          </span>
        </div>
      </div>
    </section>
  );
}

function formatDetailDate(value?: string): string {
  if (!value) {
    return 'Unknown';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown';
  }

  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDetailDateOnly(value?: string): string {
  if (!value) {
    return 'Unknown';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Unknown';
  }

  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function SelectionDetailsPanel({
  selectedRow,
  disabled,
  canDownload,
  canShare,
  onDownload,
  onShare,
  onDelete,
}: {
  selectedRow: BrowseRow | null;
  disabled: boolean;
  canDownload: boolean;
  canShare: boolean;
  onDownload: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const title = selectedRow?.name ?? 'File Details';
  const typeLabel = selectedRow?.typeLabel ?? 'Select a file';
  const createdTime = selectedRow?.entry.kind === 'file' ? selectedRow.entry.node.createdTime : undefined;
  const sourceLabel = selectedRow?.accountLabels[0] ?? 'Unknown';

  return (
    <aside className="hidden w-[252px] shrink-0 bg-[#071527]/92 xl:flex xl:flex-col">
      <div className="flex h-14 items-center justify-between px-5">
        <p className="text-base font-semibold text-slate-200">
          File Details
        </p>
        <X className="h-5 w-5 text-slate-400" />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div
          className="h-[112px] overflow-hidden rounded-md shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
          style={{
            background:
              'radial-gradient(circle at 12% 88%, rgba(35, 205, 224, 0.72), transparent 18%), radial-gradient(circle at 88% 82%, rgba(232, 32, 168, 0.78), transparent 24%), radial-gradient(circle at 26% 28%, rgba(61, 199, 224, 0.52), transparent 34%), radial-gradient(circle at 82% 6%, rgba(87, 75, 196, 0.44), transparent 30%), linear-gradient(150deg, #102a4a 0%, #17264a 42%, #211946 70%, #083250 100%)',
          }}
        >
          <div className="h-full w-full bg-[radial-gradient(circle_at_50%_50%,rgba(255,255,255,0.11)_1px,transparent_1px)] bg-[length:5px_5px] opacity-20" />
        </div>
        <h3 className="mt-5 truncate font-display text-sm font-semibold text-slate-200">
          {title}
        </h3>
        <p className="mt-1 text-sm font-semibold text-slate-500">{typeLabel}</p>

        {selectedRow ? (
          <div className="mt-5 space-y-0">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-5 py-5">
              <div>
                <dt className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">Size</dt>
                <dd className="mt-2 text-sm font-semibold leading-5 text-slate-300">
                  {humanizeBytes(selectedRow.sizeBytes)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">Source</dt>
                <dd className="mt-2 text-sm font-semibold leading-5 text-slate-300">
                  {sourceLabel}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">Created</dt>
                <dd className="mt-2 text-sm font-semibold leading-5 text-slate-300">
                  {formatDetailDateOnly(createdTime)}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">Modified</dt>
                <dd className="mt-2 text-sm font-semibold leading-5 text-slate-300">
                  {formatDetailDate(selectedRow.modifiedTime)}
                </dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="mt-6 text-sm leading-6 text-slate-400">
            Select a row or card to inspect its storage source, path, type, and available actions.
          </p>
        )}
      </div>

      <div className="space-y-2 px-5 py-5">
        <DetailAction
          disabled={disabled || !canDownload}
          icon={<Download className="h-4 w-4" />}
          label="Download"
          onClick={onDownload}
        />
        <DetailAction
          disabled={disabled || !canShare}
          icon={<Share2 className="h-4 w-4" />}
          label="Share File"
          onClick={onShare}
        />
        <DetailAction
          disabled={disabled}
          icon={<Tag className="h-4 w-4" />}
          label="Edit Tags"
          onClick={() => undefined}
        />
        <DetailAction
          disabled={disabled}
          icon={<Trash2 className="h-4 w-4" />}
          label="Move to Trash"
          tone="danger"
          onClick={onDelete}
        />
      </div>
    </aside>
  );
}

function PracticalityStrip({
  disabled,
  jobs,
  insights,
  nodes,
  accounts,
  duplicateGroups,
  onRefresh,
  onCancelJob,
  onJumpToDuplicateNodes,
  onDeleteDuplicateNodes,
  onTransferDuplicateNodes,
}: {
  disabled: boolean;
  jobs: DriveJob[];
  insights: StorageInsight[];
  nodes: UnifiedNode[];
  accounts: AccountState[];
  duplicateGroups: LocalIndexDuplicateGroup[];
  onRefresh: () => void;
  onCancelJob: (jobId: string) => void;
  onJumpToDuplicateNodes: (nodes: UnifiedNode[]) => void;
  onDeleteDuplicateNodes: (nodes: UnifiedNode[]) => void;
  onTransferDuplicateNodes: (nodes: UnifiedNode[]) => void;
}) {
  const activeJobs = jobs.filter((job) => !['completed', 'cancelled', 'failed'].includes(job.status));
  const visibleJobs = activeJobs.slice(0, 2);
  const topInsights = insights.slice(0, 2);
  const resolvedDuplicateGroups = useMemo(
    () => resolveDuplicateReviewGroups(duplicateGroups, nodes),
    [duplicateGroups, nodes],
  );
  const duplicateInsight = insights.find((insight) => insight.kind === 'duplicates');
  const [isDuplicatePanelOpen, setIsDuplicatePanelOpen] = useState(false);
  const [selectedDuplicateIds, setSelectedDuplicateIds] = useState<string[]>([]);

  useEffect(() => {
    const validDuplicateIds = new Set(
      resolvedDuplicateGroups.flatMap((group) => group.duplicateNodes.map((node) => node.id)),
    );
    setSelectedDuplicateIds((current) => current.filter((id) => validDuplicateIds.has(id)));
  }, [resolvedDuplicateGroups]);

  const selectedDuplicateNodes = useMemo(() => {
    const nodeById = new Map(
      resolvedDuplicateGroups
        .flatMap((group) => group.duplicateNodes)
        .map((node) => [node.id, node]),
    );
    return selectedDuplicateIds
      .map((nodeId) => nodeById.get(nodeId))
      .filter((node): node is UnifiedNode => Boolean(node));
  }, [resolvedDuplicateGroups, selectedDuplicateIds]);
  const selectedDuplicateBytes = duplicateSelectionBytes(selectedDuplicateNodes);
  const selectedDuplicateLabels = duplicateSelectionAccountLabels(selectedDuplicateNodes, accounts);

  if (activeJobs.length === 0 && topInsights.length === 0) {
    return null;
  }

  return (
    <section className="mt-3 rounded-md border border-cyan-100/10 bg-[#061426]/72 px-3 py-2 shadow-[0_12px_30px_rgba(0,0,0,0.12)]">
      <div className="flex flex-wrap items-center gap-2">
        {topInsights.length > 0 ? (
          <>
            <p className="mr-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-200">
              Cleanup
            </p>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              {topInsights.map((insight) => (
                <button
                  key={insight.id}
                  type="button"
                  onClick={() => {
                    if (insight.kind === 'duplicates' && resolvedDuplicateGroups.length > 0) {
                      setIsDuplicatePanelOpen((current) => !current);
                    }
                  }}
                  disabled={insight.kind === 'duplicates' && resolvedDuplicateGroups.length === 0}
                  className="inline-flex max-w-[28rem] items-center gap-2 rounded-md border border-cyan-100/10 bg-white/[0.035] px-3 py-2 text-left transition hover:bg-white/[0.05] disabled:cursor-default disabled:opacity-70"
                >
                  <span className="truncate text-xs font-semibold text-slate-100">{insight.title}</span>
                  <span className="hidden truncate text-xs text-slate-500 md:inline">{insight.description}</span>
                  {insight.kind === 'duplicates' && resolvedDuplicateGroups.length > 0 ? (
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">
                      Review
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </>
        ) : null}

        {visibleJobs.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-cyan-100/10 bg-slate-950/35 px-3 py-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Active
            </span>
            {visibleJobs.map((job) => {
              const progress = Math.max(0, Math.min(100, job.progress));
              const canCancel = ['queued', 'running', 'paused', 'retrying'].includes(job.status);
              return (
                <div key={job.id} className="flex items-center gap-2">
                  <span className="max-w-[12rem] truncate text-xs font-semibold text-slate-200">
                    {job.label}
                  </span>
                  <span className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-800">
                    <span
                      className="block h-full rounded-full bg-cyan-300"
                      style={{ width: `${progress}%` }}
                    />
                  </span>
                  {canCancel ? (
                    <button
                      type="button"
                      onClick={() => onCancelJob(job.id)}
                      className="text-xs font-semibold text-slate-500 transition hover:text-red-200"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        <button
          type="button"
          onClick={onRefresh}
          className="ml-auto text-xs font-semibold text-slate-400 transition hover:text-cyan-100"
        >
          Refresh
        </button>
      </div>

        {duplicateInsight && isDuplicatePanelOpen && resolvedDuplicateGroups.length > 0 ? (
          <div className="mt-4 rounded-xl border border-cyan-100/10 bg-slate-950/35 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-100">Duplicate review</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Keep the first file in each group and act on the duplicates underneath it.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span>{resolvedDuplicateGroups.length} groups</span>
                <span>•</span>
                <span>{humanizeBytes(totalReclaimableBytes(resolvedDuplicateGroups))} reclaimable</span>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-cyan-100/10 bg-white/[0.03] p-3">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Selected
              </span>
              <span className="text-sm font-semibold text-slate-100">
                {selectedDuplicateNodes.length} files
              </span>
              <span className="text-xs text-slate-400">
                {humanizeBytes(selectedDuplicateBytes)}
              </span>
              {selectedDuplicateLabels.length > 0 ? (
                <span className="text-xs text-slate-400">
                  • {selectedDuplicateLabels.join(', ')}
                </span>
              ) : null}
              <div className="ml-auto flex flex-wrap gap-2">
                <ActionButton
                  disabled={disabled || selectedDuplicateNodes.length === 0}
                  icon={<Search className="h-4 w-4" />}
                  label="Jump To Files"
                  onClick={() => onJumpToDuplicateNodes(selectedDuplicateNodes)}
                />
                <ActionButton
                  disabled={disabled || selectedDuplicateNodes.length === 0}
                  icon={<ArrowRightLeft className="h-4 w-4" />}
                  label="Transfer Selected"
                  onClick={() => onTransferDuplicateNodes(selectedDuplicateNodes)}
                />
                <ActionButton
                  disabled={disabled || selectedDuplicateNodes.length === 0}
                  icon={<Trash2 className="h-4 w-4" />}
                  label="Delete Selected"
                  onClick={() => onDeleteDuplicateNodes(selectedDuplicateNodes)}
                />
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {resolvedDuplicateGroups.map((group) => {
                const groupDuplicateIds = group.duplicateNodes.map((node) => node.id);
                const allSelected =
                  groupDuplicateIds.length > 0 &&
                  groupDuplicateIds.every((nodeId) => selectedDuplicateIds.includes(nodeId));

                return (
                  <div
                    key={group.id}
                    className="rounded-xl border border-cyan-100/10 bg-white/[0.035] p-4"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <p className="text-sm font-semibold text-slate-100">
                          Keep {group.keepNode.filename}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">
                          {group.reason === 'checksum' ? 'Exact checksum match' : 'Matching name and size'} • {group.nodes.length} files • {humanizeBytes(group.reclaimableBytes)} reclaimable
                        </p>
                        <p className="mt-1 text-xs text-slate-500">{group.keepNode.virtualPath}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <ActionButton
                          disabled={disabled}
                          icon={<CheckSquare className="h-4 w-4" />}
                          label={allSelected ? 'Unselect Group' : 'Select Duplicates'}
                          onClick={() => {
                            setSelectedDuplicateIds((current) =>
                              allSelected
                                ? current.filter((nodeId) => !groupDuplicateIds.includes(nodeId))
                                : [...new Set([...current, ...groupDuplicateIds])],
                            );
                          }}
                        />
                        <ActionButton
                          disabled={disabled}
                          icon={<Search className="h-4 w-4" />}
                          label="Jump"
                          onClick={() => onJumpToDuplicateNodes(group.nodes)}
                        />
                      </div>
                    </div>

                    <div className="mt-4 space-y-2">
                      {group.duplicateNodes.map((node) => {
                        const isSelected = selectedDuplicateIds.includes(node.id);
                        return (
                          <label
                            key={node.id}
                            className="flex cursor-pointer items-start gap-3 rounded-lg border border-cyan-100/10 bg-slate-950/25 px-3 py-3 transition hover:bg-white/[0.04]"
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => {
                                setSelectedDuplicateIds((current) =>
                                  current.includes(node.id)
                                    ? current.filter((nodeId) => nodeId !== node.id)
                                    : [...current, node.id],
                                );
                              }}
                              className="mt-1 h-4 w-4 rounded border-cyan-200/30 bg-slate-950/80 text-cyan-300"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <p className="truncate text-sm font-semibold text-slate-100">
                                  {node.filename}
                                </p>
                                <span className="rounded-full bg-cyan-400/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-100 ring-1 ring-cyan-300/20">
                                  {accounts.find((account) => account.accountId === node.accountId)?.label ?? node.accountId}
                                </span>
                              </div>
                              <p className="mt-1 break-words text-xs text-slate-400">
                                {node.virtualPath}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                {humanizeBytes(node.sizeBytes)}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
    </section>
  );
}

function RevisionsPanel({
  panel,
  onClose,
}: {
  panel: {
    node: UnifiedNode;
    revisions: DriveRevision[];
    isLoading: boolean;
    errorMessage: string | null;
  };
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-0 z-40 flex justify-end bg-slate-950/45 backdrop-blur-sm">
      <section className="flex h-full w-full max-w-[500px] flex-col border-l border-cyan-100/10 bg-[#071527]/95 shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-cyan-100/10 px-6 py-5">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200">
              Revision History
            </p>
            <h2 className="mt-2 truncate font-display text-2xl font-semibold text-slate-100">
              {panel.node.filename}
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              Read-only metadata from Google Drive revisions.
            </p>
          </div>
          <button type="button" onClick={onClose} className="glass-icon-button" aria-label="Close revisions">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {panel.isLoading ? (
            <div className="rounded-xl border border-cyan-100/10 bg-white/[0.035] p-4 text-sm text-slate-300">
              Loading revisions from Google Drive...
            </div>
          ) : null}

          {panel.errorMessage ? (
            <div className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-100">
              {panel.errorMessage}
            </div>
          ) : null}

          {!panel.isLoading && !panel.errorMessage && panel.revisions.length === 0 ? (
            <div className="rounded-xl border border-cyan-100/10 bg-white/[0.035] p-4 text-sm leading-6 text-slate-300">
              Google Drive did not return revision entries for this file. Some file types expose limited revision metadata through the API.
            </div>
          ) : null}

          <div className="space-y-3">
            {panel.revisions.map((revision) => {
              const parsedSize = revision.size ? Number(revision.size) : 0;
              const sizeLabel =
                Number.isFinite(parsedSize) && parsedSize > 0
                  ? humanizeBytes(parsedSize)
                  : 'Metadata';

              return (
                <article
                  key={revision.id}
                  className="rounded-xl border border-cyan-100/10 bg-white/[0.035] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-100">
                        Revision {revision.id}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        {formatDetailDate(revision.modifiedTime)}
                      </p>
                    </div>
                    <span className="rounded-full bg-cyan-400/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-100 ring-1 ring-cyan-300/20">
                      {sizeLabel}
                    </span>
                  </div>
                  <p className="mt-3 break-words text-xs text-slate-500">
                    {revision.mimeType ?? 'Unknown MIME type'}
                  </p>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function CommandPalette({
  onClose,
  onRefresh,
  onSyncVisibleScope,
  onUpload,
  onCreateFolder,
  onOpenSettings,
  onEnterSelectMode,
}: {
  onClose: () => void;
  onRefresh: () => void;
  onSyncVisibleScope: () => void;
  onUpload: () => void;
  onCreateFolder: () => void;
  onOpenSettings: () => void;
  onEnterSelectMode: () => void;
}) {
  const actions = [
    { label: 'Refresh index', description: 'Reload account storage and file metadata.', onClick: onRefresh },
    { label: 'Sync visible drive', description: 'Use Drive change tokens for the current physical drive when available.', onClick: onSyncVisibleScope },
    { label: 'Upload files', description: 'Add local files to the current virtual folder.', onClick: onUpload },
    { label: 'Create folder', description: 'Create a new virtual folder.', onClick: onCreateFolder },
    { label: 'Select items', description: 'Enter bulk action mode for transfer, rename, and delete.', onClick: onEnterSelectMode },
    { label: 'Settings', description: 'Open theme, sync, cache, and safety settings.', onClick: onOpenSettings },
  ];

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-slate-950/45 px-6 pt-24 backdrop-blur-sm">
      <section className="glass-panel w-full max-w-2xl overflow-hidden rounded-xl shadow-2xl">
        <div className="flex items-center justify-between border-b border-cyan-100/10 px-5 py-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200">
              Command Palette
            </p>
            <h2 className="mt-2 font-display text-xl font-semibold text-slate-100">
              Quick actions
            </h2>
          </div>
          <button type="button" onClick={onClose} className="glass-icon-button" aria-label="Close command palette">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-3">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              className="block w-full rounded-lg px-4 py-3 text-left transition hover:bg-white/5"
            >
              <span className="block text-sm font-semibold text-slate-100">{action.label}</span>
              <span className="mt-1 block text-xs text-slate-400">{action.description}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function FirstRunSetup({ onComplete }: { onComplete: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-6 backdrop-blur-md">
      <section className="glass-panel max-w-2xl rounded-xl p-7 shadow-2xl">
        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200">
          Welcome to OmniDrive
        </p>
        <h2 className="mt-3 font-display text-3xl font-semibold text-slate-100">
          One place for many cloud accounts
        </h2>
        <div className="mt-5 grid gap-3 text-sm leading-6 text-slate-300">
          <p>
            Google Drive accounts can be browsed, searched, uploaded to, renamed, deleted, transferred, shared, and previewed from the desktop app.
          </p>
          <p>
            Google Photos support is read-only and limited by Google Picker sessions. Each session can expose up to 2000 user-selected items, and OmniDrive will not claim automatic full-library mirroring.
          </p>
          <p>
            Tokens stay in your OS keyring. OmniDrive keeps a local index for speed, job history, settings, and cleanup insights.
          </p>
        </div>
        <button
          type="button"
          onClick={onComplete}
          className="mt-6 rounded-lg bg-gradient-to-r from-cyan-600 to-cyan-500 px-5 py-3 text-sm font-semibold text-white transition hover:shadow-[0_0_18px_rgba(0,240,255,0.28)]"
        >
          Start Browsing
        </button>
      </section>
    </div>
  );
}

function SettingsPanel({
  settings,
  onSettingsChange,
  onClearPreviewCache,
  onClose,
}: {
  settings: AppSettings;
  onSettingsChange: (value: AppSettings) => void;
  onClearPreviewCache: () => void;
  onClose: () => void;
}) {
  const updateSetting = <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  return (
    <div className="absolute inset-0 z-40 flex justify-end bg-slate-950/45 backdrop-blur-sm">
      <section className="settings-panel flex h-full w-full max-w-[440px] flex-col border-l border-cyan-100/10 bg-[#071527]/95 shadow-2xl">
        <header className="flex items-center justify-between border-b border-cyan-100/10 px-6 py-5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-cyan-200">
              Settings
            </p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-slate-100">
              Workspace
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="glass-icon-button"
            aria-label="Close settings"
            title="Close settings"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-7 overflow-y-auto px-6 py-6">
          <SettingSection
            title="Appearance"
            description="Choose a light or dark workspace, then switch between the original luminous palette, the gold finish, or a monochrome black-and-white theme."
          >
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <PreferenceButton
                  active={settings.themeMode === 'dark'}
                  icon={<Moon className="h-4 w-4" />}
                  label="Dark"
                  onClick={() => updateSetting('themeMode', 'dark')}
                />
                <PreferenceButton
                  active={settings.themeMode === 'light'}
                  icon={<Sun className="h-4 w-4" />}
                  label="Light"
                  onClick={() => updateSetting('themeMode', 'light')}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <PreferenceButton
                  active={settings.themeVariant === 'classic'}
                  icon={<Command className="h-4 w-4" />}
                  label="Classic"
                  onClick={() => updateSetting('themeVariant', 'classic')}
                />
                <PreferenceButton
                  active={settings.themeVariant === 'gold'}
                  icon={<Sun className="h-4 w-4" />}
                  label="Gold"
                  onClick={() => updateSetting('themeVariant', 'gold')}
                />
                <PreferenceButton
                  active={settings.themeVariant === 'mono'}
                  icon={<Contrast className="h-4 w-4" />}
                  label="Mono"
                  onClick={() => updateSetting('themeVariant', 'mono')}
                />
              </div>
            </div>
          </SettingSection>

          <SettingSection
            title="Default Browser View"
            description="Choose the browsing mode OmniDrive should keep using across folders and categories."
          >
            <div className="grid grid-cols-2 gap-3">
              <PreferenceButton
                active={settings.defaultViewMode === 'list'}
                icon={<List className="h-4 w-4" />}
                label="List"
                onClick={() => updateSetting('defaultViewMode', 'list')}
              />
              <PreferenceButton
                active={settings.defaultViewMode === 'grid'}
                icon={<LayoutGrid className="h-4 w-4" />}
                label="Grid"
                onClick={() => updateSetting('defaultViewMode', 'grid')}
              />
            </div>
          </SettingSection>

          <SettingSection
            title="Practical Defaults"
            description="Tune sync cadence, cache size, safety, and notifications for everyday use."
          >
            <div className="space-y-4">
              <label className="block text-sm text-slate-300">
                Sync interval
                <select
                  value={settings.syncIntervalMinutes}
                  onChange={(event) =>
                    updateSetting('syncIntervalMinutes', Number(event.target.value))
                  }
                  className="mt-2 w-full rounded-lg border border-cyan-100/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100"
                >
                  <option value={5}>Every 5 minutes</option>
                  <option value={15}>Every 15 minutes</option>
                  <option value={30}>Every 30 minutes</option>
                  <option value={60}>Hourly</option>
                </select>
              </label>
              <label className="block text-sm text-slate-300">
                Preview cache
                <select
                  value={settings.previewCacheLimitMb}
                  onChange={(event) =>
                    updateSetting('previewCacheLimitMb', Number(event.target.value))
                  }
                  className="mt-2 w-full rounded-lg border border-cyan-100/10 bg-slate-950/80 px-3 py-2 text-sm text-slate-100"
                >
                  <option value={256}>256 MB</option>
                  <option value={512}>512 MB</option>
                  <option value={1024}>1 GB</option>
                  <option value={2048}>2 GB</option>
                </select>
              </label>
              <ToggleRow
                checked={settings.notificationsEnabled}
                label="Desktop notifications"
                onChange={(checked) => updateSetting('notificationsEnabled', checked)}
              />
              <ToggleRow
                checked={settings.safeTransferEnabled}
                label="Safe transfer mode"
                onChange={(checked) => updateSetting('safeTransferEnabled', checked)}
              />
              <button
                type="button"
                onClick={onClearPreviewCache}
                className="w-full rounded-lg border border-cyan-100/10 bg-slate-950/70 px-4 py-3 text-sm font-semibold text-cyan-100 transition hover:bg-white/5"
              >
                Clear Preview Cache
              </button>
            </div>
          </SettingSection>

          <SettingSection
            title="Account Safety"
            description="Tokens stay in the OS keyring. Disconnecting an account removes its stored refresh token."
          >
            <div className="rounded-xl border border-cyan-100/10 bg-white/[0.035] p-4 text-sm text-slate-400">
              Google Photos remains read-only. Google Drive file changes only run after an explicit action.
            </div>
          </SettingSection>
        </div>
      </section>
    </div>
  );
}

function ToggleRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-xl border border-cyan-100/10 bg-white/[0.035] p-4 text-sm text-slate-300">
      {label}
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-cyan-300/30 bg-slate-950/50 text-cyan-400 focus:ring-cyan-400"
      />
    </label>
  );
}

function SettingSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="font-display text-base font-semibold text-slate-100">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function PreferenceButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'luxury-preference-button inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm font-semibold transition active:scale-[0.98]',
        active
          ? 'border-cyan-300/40 bg-cyan-400/15 text-cyan-100 shadow-[0_0_18px_rgba(0,240,255,0.12)]'
          : 'border-cyan-100/10 bg-slate-950/50 text-slate-300 hover:bg-white/5',
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  );
}

function ViewModeButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={[
        'luxury-view-toggle inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl transition active:scale-[0.98]',
        active
          ? 'bg-cyan-300/90 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_0_18px_rgba(0,240,255,0.16)]'
          : 'bg-white/[0.055] text-slate-300 ring-1 ring-cyan-100/10 hover:bg-white/[0.1] hover:text-cyan-100',
      ].join(' ')}
    >
      {icon}
    </button>
  );
}

function RowContextMenu({
  menuRef,
  row,
  x,
  y,
  account,
  onClose,
  onOpen,
  onUploadInto,
  onCreateInside,
  onRename,
  onDelete,
  onDownload,
  onShare,
  onShowRevisions,
  onCopyPath,
}: {
  menuRef: RefObject<HTMLDivElement>;
  row: BrowseRow;
  x: number;
  y: number;
  account: AccountState | null;
  onClose: () => void;
  onOpen: () => void;
  onUploadInto: () => void;
  onCreateInside: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onShare: () => void;
  onShowRevisions: () => void;
  onCopyPath: () => void;
}) {
  const isFile = row.entry.kind === 'file';
  const isRootFolder = row.entry.kind === 'directory' && row.virtualPath === '/';
  const isDriveFile = isFile && account?.sourceKind === 'drive';

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        ref={menuRef}
        data-custom-context-menu="true"
        className="glass-panel absolute w-[240px] overflow-hidden rounded-2xl border border-cyan-100/10 bg-[#071527]/96 p-2 shadow-[0_20px_60px_rgba(0,0,0,0.32)]"
        style={{ left: x, top: y }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-cyan-100/[0.06] px-3 py-2.5">
          <p className="truncate text-sm font-semibold text-slate-100">{row.name}</p>
          <p className="mt-1 truncate text-[11px] uppercase tracking-[0.16em] text-slate-500">
            {isFile ? row.typeLabel : 'Folder'}
          </p>
        </div>

        <div className="py-1">
          {isFile ? (
            <>
              <ContextMenuButton icon={<Eye className="h-4 w-4" />} label="Open preview" onClick={onOpen} />
              <ContextMenuButton icon={<Download className="h-4 w-4" />} label="Download" onClick={onDownload} />
              {isDriveFile ? (
                <>
                  <ContextMenuButton icon={<Share2 className="h-4 w-4" />} label="Share" onClick={onShare} />
                  <ContextMenuButton icon={<History className="h-4 w-4" />} label="Manage versions" onClick={onShowRevisions} />
                </>
              ) : null}
              <ContextMenuDivider />
              <ContextMenuButton icon={<Pencil className="h-4 w-4" />} label="Rename" onClick={onRename} />
              <ContextMenuButton icon={<Copy className="h-4 w-4" />} label="Copy path" onClick={onCopyPath} />
              {isDriveFile ? (
                <ContextMenuButton icon={<Trash2 className="h-4 w-4" />} label="Move to trash" onClick={onDelete} danger />
              ) : null}
            </>
          ) : (
            <>
              <ContextMenuButton icon={<FolderOpen className="h-4 w-4" />} label="Open folder" onClick={onOpen} />
              <ContextMenuButton icon={<Upload className="h-4 w-4" />} label="Upload files" onClick={onUploadInto} />
              <ContextMenuButton icon={<FolderPlus className="h-4 w-4" />} label="New folder" onClick={onCreateInside} />
              <ContextMenuDivider />
              {!isRootFolder ? (
                <ContextMenuButton icon={<Pencil className="h-4 w-4" />} label="Rename" onClick={onRename} />
              ) : null}
              <ContextMenuButton icon={<Copy className="h-4 w-4" />} label="Copy path" onClick={onCopyPath} />
              {!isRootFolder ? (
                <ContextMenuButton icon={<Trash2 className="h-4 w-4" />} label="Move to trash" onClick={onDelete} danger />
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ContextMenuDivider() {
  return <div className="my-1 border-t border-cyan-100/[0.06]" />;
}

function ContextMenuButton({
  icon,
  label,
  onClick,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium transition',
        danger
          ? 'text-red-300 hover:bg-red-400/10 hover:text-red-200'
          : 'text-slate-200 hover:bg-white/[0.05] hover:text-cyan-100',
      ].join(' ')}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.045] text-slate-300">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function ToggleChip({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-semibold transition active:scale-[0.98]',
        active
          ? 'bg-cyan-300/90 text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.2),0_0_18px_rgba(0,240,255,0.16)]'
          : 'text-slate-300 hover:bg-white/[0.06] hover:text-cyan-100',
      ].join(' ')}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function DetailAction({
  disabled,
  icon,
  label,
  onClick,
  tone = 'default',
}: {
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        'flex w-full items-center gap-4 rounded-md px-2 py-2.5 text-left text-sm font-semibold transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'danger'
          ? 'text-red-300 hover:bg-red-400/10 hover:text-red-200'
          : 'text-slate-300 hover:bg-white/[0.045] hover:text-slate-100',
      ].join(' ')}
    >
      <span
        className={[
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border shadow-[inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-xl',
          tone === 'danger'
            ? 'border-red-200/15 bg-red-300/10 text-red-300'
            : 'border-cyan-100/[0.12] bg-white/[0.06] text-slate-300',
        ].join(' ')}
      >
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );
}

function ActionButton({
  disabled,
  icon,
  label,
  onClick,
}: {
  disabled: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="luxury-action-button inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-cyan-100/15 bg-slate-900/70 px-3.5 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-white/5 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {icon}
      {label}
    </button>
  );
}

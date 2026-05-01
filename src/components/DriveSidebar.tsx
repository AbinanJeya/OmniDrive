import {
  FileAudio2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo2,
  FolderArchive,
  HardDrive,
  Link2Off,
  Plus,
  Search,
} from 'lucide-react';
import type { ComponentType, DragEvent, ReactNode } from 'react';
import { computeStorageSummary } from '../domain/driveView';
import type { AccountState, BrowseCategory, BrowseScope, FileCategory } from '../domain/types';

interface DriveSidebarProps {
  accounts: AccountState[];
  activeScope: BrowseScope;
  activeCategory: BrowseCategory;
  disabled: boolean;
  isConnecting: boolean;
  onSelectScope: (scope: BrowseScope) => void;
  onSelectCategory: (category: Exclude<FileCategory, 'folders'>) => void;
  onConnectAccount: () => void;
  onConnectPhotosAccount: () => void;
  onDisconnectAccount: (accountId: string, label: string) => void;
  dragTransfer?: {
    rowCount: number;
    targetAccountIds: string[];
    overAccountId?: string | null;
  } | null;
  onDriveDragOver?: (accountId: string, event: DragEvent<HTMLDivElement>) => void;
  onDriveDragLeave?: (accountId: string) => void;
  onDriveDrop?: (accountId: string, event: DragEvent<HTMLDivElement>) => void;
}

const CATEGORY_ITEMS: Array<{
  category: Exclude<FileCategory, 'folders'>;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { category: 'documents', label: 'Documents', icon: FileText },
  { category: 'spreadsheets', label: 'Spreadsheets', icon: FileSpreadsheet },
  { category: 'pdfs', label: 'PDFs', icon: FileText },
  { category: 'images', label: 'Images', icon: FileImage },
  { category: 'videos', label: 'Videos', icon: FileVideo2 },
  { category: 'audio', label: 'Audio', icon: FileAudio2 },
  { category: 'text', label: 'Text', icon: Search },
  { category: 'archives', label: 'Archives', icon: FolderArchive },
  { category: 'other', label: 'Other', icon: HardDrive },
];

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

function accountStatus(account: AccountState): string {
  if (account.isConnected) {
    return `${humanizeBytes(account.usedBytes)} / ${humanizeBytes(account.totalBytes)}`;
  }

  if (account.loadError?.includes('No matching entry found in secure storage')) {
    return 'Reconnect required';
  }

  return 'Unavailable';
}

function accountSourceLabel(sourceKind: AccountState['sourceKind']): string {
  return sourceKind === 'photos' ? 'Photos' : 'Drive';
}

export function DriveSidebar({
  accounts,
  activeScope,
  activeCategory,
  disabled,
  isConnecting,
  onSelectScope,
  onSelectCategory,
  onConnectAccount,
  onConnectPhotosAccount,
  onDisconnectAccount,
  dragTransfer,
  onDriveDragOver,
  onDriveDragLeave,
  onDriveDrop,
}: DriveSidebarProps) {
  const storageSummary = computeStorageSummary(accounts, { kind: 'all' });
  const totalBytes = storageSummary.totalBytes;
  const usedBytes = storageSummary.usedBytes;
  const usagePercent = storageSummary.usagePercent;

  return (
    <aside className="flex h-full min-h-0 flex-col overflow-hidden border-r border-cyan-100/10 bg-[#030d1b]/95 px-5 py-4 shadow-2xl backdrop-blur-2xl">
      <div className="shrink-0 pb-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-cyan-400/10 text-cyan-300 ring-1 ring-cyan-300/20">
            <HardDrive className="h-4 w-4" />
          </span>
          <div>
            <h1 className="font-display text-lg font-bold tracking-tight text-gradient">
              OmniDrive
            </h1>
            <p className="text-xs text-slate-400">Pro Account</p>
          </div>
        </div>
      </div>

      <nav className="sidebar-scroll-hidden min-h-0 flex-1 overflow-y-auto pr-1">
        <SidebarGroup title="My Files">
          <SidebarButton
            active={activeScope.kind === 'all' && activeCategory === 'all'}
            icon={HardDrive}
            label="My Files"
            onClick={() => onSelectScope({ kind: 'all' })}
          />
          {CATEGORY_ITEMS.slice(0, 4).map((item) => (
            <SidebarButton
              key={item.category}
              active={activeCategory === item.category}
              icon={item.icon}
              label={item.label}
              onClick={() => onSelectCategory(item.category)}
            />
          ))}
        </SidebarGroup>

        <SidebarGroup title="Storage Locations">
          {accounts.map((account) => {
            const isDragTarget = Boolean(
              dragTransfer?.targetAccountIds.includes(account.accountId),
            );
            const isDragUnavailable = Boolean(dragTransfer) && !isDragTarget;
            const isDragOver = dragTransfer?.overAccountId === account.accountId;

            return (
            <div
              key={account.accountId}
              onDragOver={(event) => onDriveDragOver?.(account.accountId, event)}
              onDragLeave={() => onDriveDragLeave?.(account.accountId)}
              onDrop={(event) => onDriveDrop?.(account.accountId, event)}
              className={[
                'rounded-2xl transition',
                isDragTarget ? 'bg-cyan-400/[0.06] ring-1 ring-cyan-300/15' : 'hover:bg-white/[0.035]',
                isDragOver ? 'bg-cyan-300/15 ring-2 ring-cyan-200/45 shadow-[0_0_26px_rgba(0,240,255,0.16)]' : '',
                isDragUnavailable ? 'opacity-25 grayscale' : '',
              ].join(' ')}
            >
              <SidebarButton
                active={activeScope.kind === 'account' && activeScope.accountId === account.accountId}
                icon={HardDrive}
                label={`${accountSourceLabel(account.sourceKind)} ${account.label}`}
                description={account.displayName}
                onClick={() => onSelectScope({ kind: 'account', accountId: account.accountId })}
              />
              <div className="mb-2 ml-8 flex items-center justify-between gap-2 pr-1">
                <p className="min-w-0 truncate text-[11px] text-slate-500">{accountStatus(account)}</p>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onDisconnectAccount(account.accountId, account.label)}
                  className="inline-flex items-center text-[11px] font-semibold text-cyan-200 transition hover:text-cyan-50 disabled:cursor-not-allowed disabled:opacity-60"
                  title={account.isConnected ? 'Disconnect account' : 'Remove account'}
                >
                  <Link2Off className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            );
          })}
        </SidebarGroup>

        <SidebarGroup title="More Types">
          {CATEGORY_ITEMS.slice(4).map((item) => (
            <SidebarButton
              key={item.category}
              active={activeCategory === item.category}
              icon={item.icon}
              label={item.label}
              onClick={() => onSelectCategory(item.category)}
            />
          ))}
        </SidebarGroup>
      </nav>

      <div className="shrink-0 border-t border-cyan-100/10 pt-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-slate-300">Storage</p>
          <p className="text-xs font-semibold text-cyan-200">{usagePercent.toFixed(0)}% Full</p>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
          <div
            className="accent-track h-full rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${usagePercent}%` }}
          />
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          {humanizeBytes(usedBytes)} of {humanizeBytes(totalBytes)} used
        </p>
        <button
          type="button"
          onClick={onConnectAccount}
          disabled={disabled || isConnecting}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full border border-cyan-300/15 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-400/15 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus className="h-4 w-4" />
          {isConnecting ? 'Connecting...' : 'Add Drive'}
        </button>

        <button
          type="button"
          onClick={onConnectPhotosAccount}
          disabled={disabled || isConnecting}
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-full border border-cyan-100/10 bg-slate-900/70 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/5 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus className="h-4 w-4" />
          {isConnecting ? 'Connecting...' : 'Add Photos'}
        </button>
      </div>
    </aside>
  );
}

function SidebarGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-5">
      <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        {title}
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function SidebarButton({
  active,
  icon: Icon,
  label,
  description,
  onClick,
}: {
  active: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  description?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition duration-200 active:scale-[0.98]',
        active
          ? 'bg-cyan-400/15 text-cyan-100 ring-1 ring-cyan-300/20 shadow-[inset_-2px_0_0_rgba(0,240,255,0.85)]'
          : 'text-slate-300 hover:bg-white/5 hover:text-cyan-100',
      ].join(' ')}
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-lg text-cyan-200">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-display text-xs font-semibold">{label}</span>
        {description ? <span className="block truncate text-xs text-slate-500">{description}</span> : null}
      </span>
    </button>
  );
}

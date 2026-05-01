import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, HardDrive } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  buildExplorerTree,
  computeAggregateSizeBytes,
  type VirtualDirectoryEntry,
  type VirtualExplorerEntry,
} from '../domain/explorerTree';
import { computeStorageSummary } from '../domain/driveView';
import type { AccountState } from '../domain/types';

interface FileExplorerProps {
  nodes: Parameters<typeof buildExplorerTree>[0];
  accounts: AccountState[];
  title?: string;
  description?: string;
  breadcrumbs?: string[];
  emptyMessage?: string;
  selectedEntryId?: string | null;
  onSelect?: (entry: VirtualExplorerEntry) => void;
}

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

function uniqueAccountLabels(labels: string[]): string[] {
  return [...new Set(labels)].sort((left, right) => left.localeCompare(right));
}

function renderAccountBadges(labels: string[]): ReactNode {
  const uniqueLabels = uniqueAccountLabels(labels);
  if (uniqueLabels.length === 0) {
    return null;
  }

  const visibleLabels = uniqueLabels.slice(0, 3);
  const overflowCount = uniqueLabels.length - visibleLabels.length;

  return (
    <>
      {visibleLabels.map((label) => (
        <span
          key={label}
          className="inline-flex h-5 items-center rounded-full bg-amber-100 px-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-800 ring-1 ring-amber-200"
        >
          {label}
        </span>
      ))}
      {overflowCount > 0 ? (
        <span className="inline-flex h-5 items-center rounded-full bg-white px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 ring-1 ring-slate-200">
          +{overflowCount}
        </span>
      ) : null}
    </>
  );
}

export function FileExplorer({
  nodes,
  accounts,
  title = 'Unified tree view',
  description = 'Virtual folders now merge mirrored paths across accounts while physical files remain individually addressable for download, rename, and delete operations.',
  breadcrumbs = [],
  emptyMessage = 'No files yet. Once the sync layer normalizes Drive data, the explorer will appear here.',
  selectedEntryId,
  onSelect,
}: FileExplorerProps) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(['/']));

  const root = useMemo(() => buildExplorerTree(nodes), [nodes]);
  const connectedAccounts = accounts.filter((account) => account.isConnected);
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.accountId, account])),
    [accounts],
  );
  const storageSummary = computeStorageSummary(connectedAccounts, { kind: 'all' });
  const totalUsedBytes = storageSummary.usedBytes;
  const totalCapacityBytes = storageSummary.totalBytes;
  const usagePercent = storageSummary.usagePercent;

  function toggleFolder(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function renderEntry(entry: VirtualExplorerEntry, depth: number): ReactNode {
    const isDirectory = entry.kind === 'directory';
    const isExpanded = isDirectory && expandedPaths.has(entry.virtualPath);
    const isSelected = selectedEntryId === entry.id;
    const aggregateBytes = computeAggregateSizeBytes(entry);
    const accountLabels =
      entry.kind === 'directory'
        ? entry.backingFolders
            .map((folder) => accountById.get(folder.accountId)?.label ?? folder.accountId)
            .filter(Boolean)
        : [accountById.get(entry.node.accountId)?.label ?? entry.node.accountId];

    return (
      <div key={entry.id}>
        <button
          type="button"
          onClick={() => {
            if (isDirectory) {
              toggleFolder(entry.virtualPath);
            }
            onSelect?.(entry);
          }}
          className={[
            'group flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition',
            'focus:outline-none focus:ring-2 focus:ring-amber-400/50',
            isSelected
              ? 'bg-amber-100/80 shadow-sm ring-1 ring-amber-200'
              : 'hover:bg-amber-50',
          ].join(' ')}
          style={{ paddingLeft: `${depth * 20 + 12}px` }}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-amber-600 ring-1 ring-amber-200 shadow-sm">
            {isDirectory ? (
              isExpanded ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />
            ) : (
              <FileText className="h-4 w-4" />
            )}
          </span>

          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2 truncate">
              <span className="truncate font-medium text-slate-900">{entry.name}</span>
              {renderAccountBadges(accountLabels)}
            </span>
            <span className="truncate text-xs text-slate-500">{entry.virtualPath}</span>
          </span>

          <span className="flex items-center gap-2 text-xs text-slate-500">
            <span>{humanizeBytes(aggregateBytes)}</span>
            {isDirectory ? (
              isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />
            ) : null}
          </span>
        </button>

        {isDirectory && isExpanded ? (
          <div className="ml-1 border-l border-amber-200">
            {entry.children.map((child) => renderEntry(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className="glass-panel overflow-hidden rounded-3xl shadow-glow">
      <div className="border-b border-amber-200/70 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-amber-700">
              Virtual File Explorer
            </p>
            {breadcrumbs.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-500">
                {breadcrumbs.map((segment, index) => (
                  <span key={`${segment}:${index}`} className="inline-flex items-center gap-2">
                    <span>{segment}</span>
                    {index < breadcrumbs.length - 1 ? <ChevronRight className="h-3.5 w-3.5" /> : null}
                  </span>
                ))}
              </div>
            ) : null}
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">{title}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {description}
            </p>
          </div>

          <div className="min-w-[280px] rounded-2xl bg-white/90 p-4 ring-1 ring-amber-200/80">
            <div className="flex items-center justify-between text-xs uppercase tracking-[0.24em] text-amber-700">
              <span className="inline-flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-amber-500" />
                Total Storage
              </span>
              <span>{usagePercent.toFixed(1)}%</span>
            </div>
            <div className="mt-3 h-3 overflow-hidden rounded-full bg-amber-100">
              <div
                className="accent-track h-full rounded-full transition-[width] duration-300 ease-out"
                style={{ width: `${usagePercent}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between text-sm text-slate-700">
              <span>
                Used: <span className="font-semibold text-slate-900">{humanizeBytes(totalUsedBytes)}</span>
              </span>
              <span>
                Total:{' '}
                <span className="font-semibold text-slate-900">{humanizeBytes(totalCapacityBytes)}</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="p-3">
        {root.children.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-amber-200 px-5 py-14 text-center text-sm text-slate-500">
            {emptyMessage}
          </div>
        ) : (
          <div className="space-y-1">{root.children.map((entry) => renderEntry(entry, 0))}</div>
        )}
      </div>
    </section>
  );
}

export type { VirtualDirectoryEntry, VirtualExplorerEntry };

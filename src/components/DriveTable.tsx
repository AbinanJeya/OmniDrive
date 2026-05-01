import {
  ChevronRight,
} from 'lucide-react';
import type { PointerEvent } from 'react';
import type { BrowseRow } from '../domain/browseModel';
import type { GridThumbnailState, SortField, SortModel, ThemeMode, ThemeVariant } from '../domain/types';
import { thumbnailToneClasses } from '../domain/gridPresentation';
import { ThumbnailSurface } from './DriveThumbnail';

interface DriveTableProps {
  rows: BrowseRow[];
  selectedRowIds: string[];
  isSelectMode: boolean;
  sort: SortModel;
  emptyMessage: string;
  thumbnails: Record<string, GridThumbnailState>;
  themeMode: ThemeMode;
  themeVariant: ThemeVariant;
  onSortChange: (field: SortField) => void;
  onSelectRow: (row: BrowseRow) => void;
  onOpenRow: (row: BrowseRow) => void;
  onContextMenu: (row: BrowseRow, position: { x: number; y: number }) => void;
  onPointerDown: (row: BrowseRow, event: PointerEvent<HTMLTableRowElement>) => void;
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

function formatModifiedTime(value?: string): string {
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

function SortHeader({
  active,
  direction,
  label,
  onClick,
}: {
  active: boolean;
  direction: SortModel['direction'];
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-400 transition hover:text-cyan-200"
    >
      {label}
      {active ? <span className="text-[10px]">{direction === 'asc' ? '↑' : '↓'}</span> : null}
    </button>
  );
}

export function DriveTable({
  rows,
  selectedRowIds,
  isSelectMode,
  sort,
  emptyMessage,
  thumbnails,
  themeMode,
  themeVariant,
  onSortChange,
  onSelectRow,
  onOpenRow,
  onContextMenu,
  onPointerDown,
}: DriveTableProps) {
  return (
    <section className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse">
          <thead>
            <tr className="border-b border-cyan-100/[0.04]">
              {isSelectMode ? <th className="w-10 px-4 py-3 text-left" /> : null}
              <th className="px-4 py-3 text-left">
                <SortHeader
                  active={sort.field === 'name'}
                  direction={sort.direction}
                  label="Name"
                  onClick={() => onSortChange('name')}
                />
              </th>
              <th className="px-4 py-3 text-left">
                <span className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Source
                </span>
              </th>
              <th className="px-4 py-3 text-left">
                <SortHeader
                  active={sort.field === 'modifiedTime'}
                  direction={sort.direction}
                  label="Last Modified"
                  onClick={() => onSortChange('modifiedTime')}
                />
              </th>
              <th className="px-4 py-3 text-left">
                <SortHeader
                  active={sort.field === 'sizeBytes'}
                  direction={sort.direction}
                  label="Size"
                  onClick={() => onSortChange('sizeBytes')}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={isSelectMode ? 5 : 4} className="px-4 py-16 text-center text-sm text-slate-400">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelected = selectedRowIds.includes(row.id);

                return (
                  <tr
                    key={row.id}
                    data-drive-context-target="true"
                    className={[
                      'group cursor-pointer transition duration-200',
                      isSelected ? 'bg-cyan-400/10 ring-1 ring-inset ring-cyan-300/20' : '',
                    ].join(' ')}
                    onPointerDown={(event) => onPointerDown(row, event)}
                    onContextMenuCapture={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onContextMenu(row, { x: event.clientX, y: event.clientY });
                    }}
                    onClick={() => onSelectRow(row)}
                    onDoubleClick={() => {
                      if (!isSelectMode) {
                        onOpenRow(row);
                      }
                    }}
                  >
                    {isSelectMode ? (
                      <td
                        className={[
                          'w-10 px-3 py-2 transition duration-200',
                          isSelected ? 'bg-cyan-400/[0.06] rounded-l-xl' : 'group-hover:bg-white/[0.045] group-hover:rounded-l-xl',
                        ].join(' ')}
                      >
                        <div className="flex h-full items-center">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => onSelectRow(row)}
                            onClick={(event) => event.stopPropagation()}
                            className="h-4 w-4 rounded border-cyan-300/30 bg-slate-950/50 text-cyan-400 focus:ring-cyan-400"
                            aria-label={`Select ${row.name}`}
                          />
                        </div>
                      </td>
                    ) : null}
                    <td
                      className={[
                        isSelectMode ? 'px-2 py-2' : 'px-4 py-2',
                        'transition duration-200',
                        isSelected
                          ? `${isSelectMode ? '' : 'rounded-l-xl'} bg-cyan-400/[0.06]`
                          : `${isSelectMode ? '' : 'group-hover:rounded-l-xl'} group-hover:bg-white/[0.045]`,
                      ].join(' ')}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={[
                            'block h-7 w-7 shrink-0 overflow-hidden rounded-md',
                            thumbnailToneClasses(row, themeMode, themeVariant, true).surface,
                          ].join(' ')}
                        >
                          <ThumbnailSurface
                            row={row}
                            thumbnail={thumbnails[row.id]}
                            themeMode={themeMode}
                            themeVariant={themeVariant}
                            compact
                          />
                        </span>
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onOpenRow(row);
                            }}
                            className="truncate text-left font-display text-sm font-semibold text-slate-100 transition group-hover:text-cyan-100 hover:text-cyan-200"
                          >
                            {row.name}
                          </button>
                        </div>
                      </div>
                    </td>
                    <td
                      className={[
                        'px-4 py-2 transition duration-200',
                        isSelected ? 'bg-cyan-400/[0.06]' : 'group-hover:bg-white/[0.045]',
                      ].join(' ')}
                    >
                      <div className="flex h-full items-center">
                        <div className="flex flex-wrap gap-1.5 text-xs font-medium text-slate-300 transition group-hover:text-slate-100">
                          {row.accountLabels.map((label) => (
                            <span
                              key={`${row.id}:${label}`}
                              className="inline-flex items-center gap-1"
                            >
                              {label}
                            </span>
                          ))}
                        </div>
                      </div>
                    </td>
                    <td
                      className={[
                        'px-4 py-2 text-sm text-slate-300 transition duration-200 group-hover:text-slate-100',
                        isSelected ? 'bg-cyan-400/[0.06]' : 'group-hover:bg-white/[0.045]',
                      ].join(' ')}
                    >
                      <div className="h-full">
                        {formatModifiedTime(row.modifiedTime)}
                      </div>
                    </td>
                    <td
                      className={[
                        'px-4 py-2 text-sm font-medium text-slate-300 transition duration-200 group-hover:text-slate-100',
                        isSelected ? 'bg-cyan-400/[0.06] rounded-r-xl' : 'group-hover:bg-white/[0.045] group-hover:rounded-r-xl',
                      ].join(' ')}
                    >
                      <div className="h-full">
                        <span className="inline-flex items-center gap-1">
                          {row.kind === 'directory' ? '--' : humanizeBytes(row.sizeBytes)}
                          {row.kind === 'directory' ? (
                            <ChevronRight className="h-4 w-4 text-slate-500 transition group-hover:text-cyan-200" />
                          ) : null}
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

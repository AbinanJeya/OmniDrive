import type { PointerEvent } from 'react';
import type { BrowseRow } from '../domain/browseModel';
import { gridCardMetrics, gridColumnsStyle } from '../domain/gridPresentation';
import type { GridThumbnailState, ThemeMode, ThemeVariant } from '../domain/types';
import { ThumbnailSurface } from './DriveThumbnail';

interface DriveGridProps {
  rows: BrowseRow[];
  selectedRowIds: string[];
  isSelectMode: boolean;
  emptyMessage: string;
  thumbnails: Record<string, GridThumbnailState>;
  gridCardSize: number;
  themeMode: ThemeMode;
  themeVariant: ThemeVariant;
  onSelectRow: (row: BrowseRow) => void;
  onOpenRow: (row: BrowseRow) => void;
  onContextMenu: (row: BrowseRow, position: { x: number; y: number }) => void;
  onPointerDown: (row: BrowseRow, event: PointerEvent<HTMLElement>) => void;
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

export function DriveGrid({
  rows,
  selectedRowIds,
  isSelectMode,
  emptyMessage,
  thumbnails,
  gridCardSize,
  themeMode,
  themeVariant,
  onSelectRow,
  onOpenRow,
  onContextMenu,
  onPointerDown,
}: DriveGridProps) {
  if (rows.length === 0) {
    return (
      <section className="glass-panel rounded-xl px-6 py-20 text-center shadow-glow">
        <p className="text-sm text-slate-400">{emptyMessage}</p>
      </section>
    );
  }

  const metrics = gridCardMetrics(gridCardSize);

  return (
    <section className="grid gap-4" style={gridColumnsStyle(gridCardSize)}>
      {rows.map((row) => {
        const isSelected = selectedRowIds.includes(row.id);

        return (
          <article
            key={row.id}
            data-drive-context-target="true"
            className={[
              'glass-panel group relative overflow-hidden rounded-xl shadow-glow transition duration-200',
              isSelected
                ? 'ring-2 ring-cyan-300/70 shadow-[0_0_28px_rgba(0,240,255,0.18)]'
                : 'hover:-translate-y-0.5 hover:bg-white/[0.055] hover:rounded-2xl',
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
              <label className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-slate-950/80 ring-1 ring-cyan-100/20">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => onSelectRow(row)}
                  onClick={(event) => event.stopPropagation()}
                  className="h-4 w-4 rounded border-cyan-300/30 bg-slate-950/50 text-cyan-400 focus:ring-cyan-400"
                  aria-label={`Select ${row.name}`}
                />
              </label>
            ) : null}
            <div
              className="overflow-hidden border-b border-cyan-100/10"
              style={{ height: `${metrics.thumbnailHeight}px` }}
            >
              <ThumbnailSurface
                row={row}
                thumbnail={thumbnails[row.id]}
                themeMode={themeMode}
                themeVariant={themeVariant}
              />
            </div>

            <div className={['space-y-4', metrics.contentPaddingClass].join(' ')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenRow(row);
                    }}
                    className={[
                      'w-full truncate text-left font-display font-semibold text-slate-100 transition group-hover:text-cyan-100 hover:text-cyan-200',
                      metrics.titleClass,
                    ].join(' ')}
                  >
                    {row.name}
                  </button>
                  <p className={['mt-1 truncate text-slate-500 transition group-hover:text-slate-300', metrics.detailClass].join(' ')}>
                    {row.virtualPath}
                  </p>
                </div>

                <div className="flex flex-wrap justify-end gap-1.5">
                  {row.accountLabels.map((label) => (
                    <span
                      key={`${row.id}:${label}`}
                      className="inline-flex items-center rounded-full bg-cyan-400/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-100 ring-1 ring-cyan-300/20"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>

              <div
                className={[
                  'grid grid-cols-2 gap-2 text-slate-500 transition group-hover:text-slate-300',
                  metrics.compactMeta ? 'text-[11px]' : 'text-xs',
                ].join(' ')}
              >
                <div>
                  <p className="uppercase tracking-[0.18em] text-slate-400">Type</p>
                  <p className="mt-1 text-sm font-medium text-slate-200">{row.typeLabel}</p>
                </div>
                <div>
                  <p className="uppercase tracking-[0.18em] text-slate-400">Size</p>
                  <p className="mt-1 text-sm font-medium text-slate-200">
                    {row.kind === 'directory' ? 'Folder' : humanizeBytes(row.sizeBytes)}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className="uppercase tracking-[0.18em] text-slate-400">Modified</p>
                  <p className="mt-1 text-sm font-medium text-slate-200">
                    {formatModifiedTime(row.modifiedTime)}
                  </p>
                </div>
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}

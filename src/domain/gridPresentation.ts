import type { BrowseRow } from './browseModel';
import type { ThemeMode, ThemeVariant } from './types';

export const MIN_GRID_CARD_SIZE = 140;
export const MAX_GRID_CARD_SIZE = 320;
export const DEFAULT_GRID_CARD_SIZE = 220;

export function clampGridCardSize(size: number): number {
  if (!Number.isFinite(size)) {
    return DEFAULT_GRID_CARD_SIZE;
  }

  return Math.min(MAX_GRID_CARD_SIZE, Math.max(MIN_GRID_CARD_SIZE, Math.round(size)));
}

export function gridColumnsStyle(size: number): { gridTemplateColumns: string } {
  const clamped = clampGridCardSize(size);
  return {
    gridTemplateColumns: `repeat(auto-fill, minmax(${clamped}px, 1fr))`,
  };
}

export function gridCardMetrics(size: number) {
  const clamped = clampGridCardSize(size);
  return {
    cardSize: clamped,
    thumbnailHeight: Math.round(clamped * 0.72),
    contentPaddingClass: clamped <= 170 ? 'p-3' : clamped >= 280 ? 'p-5' : 'p-4',
    compactMeta: clamped <= 170,
    titleClass: clamped <= 170 ? 'text-[13px]' : 'text-sm',
    detailClass: clamped <= 170 ? 'text-[11px]' : 'text-xs',
  };
}

export function thumbnailToneClasses(
  row: BrowseRow,
  themeMode: ThemeMode,
  themeVariant: ThemeVariant,
  compact = false,
) {
  if (themeVariant === 'mono') {
    if (themeMode === 'light') {
      return {
        surface:
          'bg-white/95 from-slate-100 via-white to-slate-100 text-slate-700 ring-1 ring-slate-900/8',
        iconChip: 'bg-slate-900/6 ring-1 ring-slate-900/8 text-slate-700',
        meta: 'text-slate-500',
        mediaBackground: 'bg-slate-100',
        videoOverlay: 'from-white/10 via-transparent to-transparent',
      };
    }

    return {
      surface:
        'bg-slate-950/95 from-white/8 via-slate-900 to-black text-slate-100 ring-1 ring-white/10',
      iconChip: 'bg-white/6 ring-1 ring-white/10 text-slate-100',
      meta: 'text-slate-400',
      mediaBackground: 'bg-slate-950',
      videoOverlay: 'from-black/20 via-transparent to-transparent',
    };
  }

  if (themeVariant === 'gold') {
    if (themeMode === 'light') {
      const accent =
        row.kind === 'directory'
          ? 'from-amber-200/60 via-white to-amber-50 text-amber-900'
          : row.fileCategory === 'spreadsheets'
            ? 'from-emerald-200/55 via-white to-amber-50 text-emerald-900'
            : row.fileCategory === 'audio'
              ? 'from-orange-200/55 via-white to-amber-50 text-orange-900'
              : 'from-amber-200/60 via-white to-amber-50 text-amber-900';
      return {
        surface: `${accent} ring-1 ring-amber-900/10`,
        iconChip: 'bg-white/80 ring-1 ring-amber-900/10 text-amber-900',
        meta: 'text-amber-900/70',
        mediaBackground: 'bg-amber-50',
        videoOverlay: 'from-amber-950/10 via-transparent to-transparent',
      };
    }

    const accent =
      row.kind === 'directory'
        ? 'from-amber-300/18 via-amber-950/80 to-stone-950 text-amber-100'
        : row.fileCategory === 'spreadsheets'
          ? 'from-emerald-300/18 via-amber-950/80 to-stone-950 text-emerald-100'
          : row.fileCategory === 'audio'
            ? 'from-orange-300/18 via-amber-950/80 to-stone-950 text-orange-100'
            : 'from-amber-300/18 via-amber-950/80 to-stone-950 text-amber-100';
    return {
      surface: `${accent} ring-1 ring-amber-200/10`,
      iconChip: 'bg-white/5 ring-1 ring-amber-100/10 text-amber-100',
      meta: 'text-amber-100/60',
      mediaBackground: 'bg-stone-950',
      videoOverlay: 'from-black/25 via-transparent to-transparent',
    };
  }

  const accent =
    row.kind === 'directory'
      ? themeMode === 'light'
        ? 'from-cyan-200/55 via-white to-sky-50 text-cyan-900'
        : 'from-cyan-400/20 via-slate-900 to-slate-950 text-cyan-200'
      : row.fileCategory === 'documents' || row.fileCategory === 'pdfs'
        ? themeMode === 'light'
          ? 'from-sky-200/55 via-white to-blue-50 text-sky-900'
          : 'from-sky-400/20 via-slate-900 to-slate-950 text-sky-200'
        : row.fileCategory === 'spreadsheets'
          ? themeMode === 'light'
            ? 'from-emerald-200/55 via-white to-teal-50 text-emerald-900'
            : 'from-emerald-400/20 via-slate-900 to-slate-950 text-emerald-200'
          : row.fileCategory === 'audio'
            ? themeMode === 'light'
              ? 'from-violet-200/55 via-white to-fuchsia-50 text-violet-900'
              : 'from-violet-400/20 via-slate-900 to-slate-950 text-violet-200'
            : themeMode === 'light'
              ? 'from-cyan-200/55 via-white to-sky-50 text-cyan-900'
              : 'from-cyan-400/20 via-slate-900 to-slate-950 text-cyan-200';

  if (themeMode === 'light') {
    return {
      surface: `${accent} ring-1 ring-slate-900/8`,
      iconChip: 'bg-white/80 ring-1 ring-slate-900/8 text-slate-700',
      meta: 'text-slate-500',
      mediaBackground: 'bg-slate-100',
      videoOverlay: 'from-slate-950/10 via-transparent to-transparent',
    };
  }

  return {
    surface: `${accent} ring-1 ring-cyan-100/10`,
    iconChip: 'bg-white/5 ring-1 ring-cyan-100/10',
    meta: 'text-slate-400',
    mediaBackground: compact ? 'bg-slate-950' : 'bg-slate-950',
    videoOverlay: 'from-black/25 via-transparent to-transparent',
  };
}

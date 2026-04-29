import { convertFileSrc } from '@tauri-apps/api/core';
import {
  FileAudio2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo2,
  Folder,
  LucideIcon,
  Sheet,
} from 'lucide-react';
import type { BrowseRow } from '../domain/browseModel';
import { thumbnailToneClasses } from '../domain/gridPresentation';
import type { GridThumbnailState, ThemeMode, ThemeVariant } from '../domain/types';

export function iconForRow(row: BrowseRow): LucideIcon {
  if (row.kind === 'directory') {
    return Folder;
  }

  switch (row.fileCategory) {
    case 'documents':
    case 'pdfs':
    case 'text':
      return FileText;
    case 'spreadsheets':
      return FileSpreadsheet;
    case 'images':
      return FileImage;
    case 'videos':
      return FileVideo2;
    case 'audio':
      return FileAudio2;
    default:
      return Sheet;
  }
}

function sourceUrl(localPath?: string): string | undefined {
  if (!localPath) {
    return undefined;
  }

  return convertFileSrc(localPath);
}

export function TypePoster({
  row,
  themeMode,
  themeVariant,
  compact = false,
}: {
  row: BrowseRow;
  themeMode: ThemeMode;
  themeVariant: ThemeVariant;
  compact?: boolean;
}) {
  const RowIcon = iconForRow(row);
  const tones = thumbnailToneClasses(row, themeMode, themeVariant, compact);

  return (
    <div
      className={[
        'flex h-full w-full flex-col items-center justify-center bg-gradient-to-br',
        compact ? 'gap-0' : 'gap-3',
        tones.surface,
      ].join(' ')}
    >
      <span
        className={[
          'flex items-center justify-center rounded-xl',
          compact ? 'h-8 w-8' : 'h-14 w-14',
          tones.iconChip,
        ].join(' ')}
      >
        <RowIcon className={compact ? 'h-4 w-4' : 'h-7 w-7'} />
      </span>
      {!compact ? (
        <div className="text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.18em]">
            {row.kind === 'directory' ? 'Folder' : row.fileExtension?.toUpperCase() ?? row.typeLabel}
          </p>
          <p className={['mt-1 text-xs', tones.meta].join(' ')}>{row.typeLabel}</p>
        </div>
      ) : null}
    </div>
  );
}

export function ThumbnailSurface({
  row,
  thumbnail,
  themeMode,
  themeVariant,
  compact = false,
}: {
  row: BrowseRow;
  thumbnail?: GridThumbnailState;
  themeMode: ThemeMode;
  themeVariant: ThemeVariant;
  compact?: boolean;
}) {
  const thumbnailUrl = sourceUrl(thumbnail?.localPath);
  const tones = thumbnailToneClasses(row, themeMode, themeVariant, compact);

  if (thumbnail?.status === 'ready' && thumbnailUrl && thumbnail.assetKind === 'image') {
    return (
      <div className={['h-full w-full overflow-hidden', tones.mediaBackground].join(' ')}>
        <img
          src={thumbnailUrl}
          alt={row.name}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }

  if (thumbnail?.status === 'ready' && thumbnailUrl && thumbnail.assetKind === 'video') {
    return (
      <div className={['relative h-full w-full overflow-hidden', tones.mediaBackground].join(' ')}>
        <video
          src={thumbnailUrl}
          muted
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
        />
        <div
          className={[
            'pointer-events-none absolute inset-0 bg-gradient-to-t',
            tones.videoOverlay,
          ].join(' ')}
        />
      </div>
    );
  }

  return <TypePoster row={row} themeMode={themeMode} themeVariant={themeVariant} compact={compact} />;
}

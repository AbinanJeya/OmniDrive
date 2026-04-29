import type { FileCategory, PreviewKind } from './types';

export const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';
export const GOOGLE_DOC_MIME_TYPE = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'tsv',
  'log',
  'xml',
  'yml',
  'yaml',
]);

const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz']);

export function deriveFileExtension(filename: string): string | undefined {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf('.');

  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return undefined;
  }

  return trimmed.slice(lastDot + 1).toLowerCase();
}

export function deriveFileCategory(mimeType: string, filename: string): FileCategory {
  const extension = deriveFileExtension(filename);

  if (mimeType === GOOGLE_FOLDER_MIME_TYPE) {
    return 'folders';
  }

  if (
    mimeType === 'application/pdf' ||
    extension === 'pdf'
  ) {
    return 'pdfs';
  }

  if (
    mimeType === GOOGLE_DOC_MIME_TYPE ||
    mimeType.includes('wordprocessingml') ||
    mimeType === 'application/msword'
  ) {
    return 'documents';
  }

  if (
    mimeType === GOOGLE_SHEET_MIME_TYPE ||
    mimeType.includes('spreadsheetml') ||
    mimeType === 'application/vnd.ms-excel'
  ) {
    return 'spreadsheets';
  }

  if (mimeType.startsWith('image/')) {
    return 'images';
  }

  if (mimeType.startsWith('video/')) {
    return 'videos';
  }

  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }

  if (mimeType.startsWith('text/') || (extension && TEXT_EXTENSIONS.has(extension))) {
    return 'text';
  }

  if (
    mimeType.includes('zip') ||
    mimeType.includes('compressed') ||
    (extension && ARCHIVE_EXTENSIONS.has(extension))
  ) {
    return 'archives';
  }

  return 'other';
}

export function derivePreviewKind(mimeType: string, filename: string): PreviewKind {
  const extension = deriveFileExtension(filename);

  if (mimeType === 'application/pdf' || extension === 'pdf') {
    return 'pdf';
  }

  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }

  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  if (
    mimeType === GOOGLE_DOC_MIME_TYPE ||
    mimeType.includes('wordprocessingml') ||
    mimeType === 'application/msword'
  ) {
    return 'docx';
  }

  if (
    mimeType === GOOGLE_SHEET_MIME_TYPE ||
    mimeType.includes('spreadsheetml') ||
    mimeType === 'application/vnd.ms-excel'
  ) {
    return 'xlsx';
  }

  if (mimeType.startsWith('text/') || (extension && TEXT_EXTENSIONS.has(extension))) {
    return 'text';
  }

  return 'unsupported';
}

export function deriveIsPreviewable(mimeType: string, filename: string): boolean {
  return derivePreviewKind(mimeType, filename) !== 'unsupported';
}

import type { DriveSnapshot, GoogleDriveFileRecord, UnifiedNode } from './types';
import {
  deriveFileCategory,
  deriveFileExtension,
  deriveIsPreviewable,
  GOOGLE_FOLDER_MIME_TYPE,
} from './fileMetadata';

export { GOOGLE_FOLDER_MIME_TYPE } from './fileMetadata';

function sanitizePathSegment(value: string): string {
  // Drive names can contain characters that are awkward in path rendering.
  // We keep the UI safe by normalizing each segment before path assembly.
  const cleaned = value.trim().replaceAll('/', '_');
  return cleaned.length > 0 ? cleaned : 'Untitled';
}

function parseSizeBytes(rawSize: string | undefined): number {
  if (!rawSize) {
    return 0;
  }

  const parsed = Number.parseInt(rawSize, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function buildGoogleIndex(files: GoogleDriveFileRecord[]): Map<string, GoogleDriveFileRecord> {
  return new Map(files.map((file) => [file.id, file]));
}

function buildVirtualPathResolver(files: GoogleDriveFileRecord[]): (googleId: string) => string {
  const byId = buildGoogleIndex(files);
  const cache = new Map<string, string>();
  const resolving = new Set<string>();

  const resolvePath = (googleId: string): string => {
    const cached = cache.get(googleId);
    if (cached) {
      return cached;
    }

    const record = byId.get(googleId);
    if (!record) {
      return '/';
    }

    if (resolving.has(googleId)) {
      throw new Error(`Detected a cyclic parent chain in Google Drive item ${googleId}.`);
    }

    // Google Drive returns a flat list; virtual paths have to be reconstructed
    // by walking the parent chain inside the normalized layer.
    resolving.add(googleId);

    const parentId = record.parents?.[0];
    const parentPath = parentId && byId.has(parentId) ? resolvePath(parentId) : '/';
    const segment = sanitizePathSegment(record.name);
    const virtualPath = parentPath === '/' ? `/${segment}` : `${parentPath}/${segment}`;

    resolving.delete(googleId);
    cache.set(googleId, virtualPath);
    return virtualPath;
  };

  return resolvePath;
}

export function normalizeDriveSnapshot(snapshot: DriveSnapshot): UnifiedNode[] {
  if (snapshot.account.sourceKind === 'photos') {
    return normalizeGooglePhotosSnapshot(snapshot);
  }

  const resolvePath = buildVirtualPathResolver(snapshot.files);

  return snapshot.files
    .filter((file) => !file.trashed)
    .map((file) => {
      const isFolder = file.mimeType === GOOGLE_FOLDER_MIME_TYPE;

      return {
        id: `${snapshot.account.accountId}:${file.id}`,
        googleId: file.id,
        accountId: snapshot.account.accountId,
        filename: file.name,
        isFolder,
        sizeBytes: isFolder ? 0 : parseSizeBytes(file.size),
        virtualPath: resolvePath(file.id),
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        createdTime: file.createdTime,
        viewedByMeTime: file.viewedByMeTime,
        starred: Boolean(file.starred),
        shared: Boolean(file.shared),
        checksum: file.md5Checksum,
        thumbnailState: 'unknown' as const,
        sourceKind: snapshot.account.sourceKind,
        previewStatus: deriveIsPreviewable(file.mimeType, file.name) ? 'previewable' as const : 'unsupported' as const,
        syncVersion: 1,
        fileCategory: deriveFileCategory(file.mimeType, file.name),
        fileExtension: deriveFileExtension(file.name),
        isPreviewable: deriveIsPreviewable(file.mimeType, file.name),
      };
    })
    .sort((left, right) => left.virtualPath.localeCompare(right.virtualPath));
}

function normalizeGooglePhotosSnapshot(snapshot: DriveSnapshot): UnifiedNode[] {
  return snapshot.files
    .filter((file) => !file.trashed)
    .map((file) => {
      const createdAt = file.modifiedTime ?? '';
      const pathPrefix = buildPhotosPathPrefix(createdAt);

      return {
        id: `${snapshot.account.accountId}:${file.id}`,
        googleId: file.id,
        accountId: snapshot.account.accountId,
        filename: file.name,
        isFolder: false,
        sizeBytes: parseSizeBytes(file.size),
        virtualPath:
          pathPrefix === '/' ? `/${sanitizePathSegment(file.name)}` : `${pathPrefix}/${sanitizePathSegment(file.name)}`,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        createdTime: file.createdTime ?? file.modifiedTime,
        viewedByMeTime: file.viewedByMeTime,
        starred: Boolean(file.starred),
        shared: Boolean(file.shared),
        checksum: file.md5Checksum,
        thumbnailState: 'unknown' as const,
        sourceKind: snapshot.account.sourceKind,
        previewStatus: deriveIsPreviewable(file.mimeType, file.name) ? 'previewable' as const : 'unsupported' as const,
        syncVersion: 1,
        fileCategory: deriveFileCategory(file.mimeType, file.name),
        fileExtension: deriveFileExtension(file.name),
        isPreviewable: deriveIsPreviewable(file.mimeType, file.name),
      };
    })
    .sort((left, right) => left.virtualPath.localeCompare(right.virtualPath));
}

function buildPhotosPathPrefix(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return '/Google Photos';
  }

  const year = String(parsed.getUTCFullYear());
  const month = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const day = String(parsed.getUTCDate()).padStart(2, '0');
  return `/Google Photos/${year}/${month}/${day}`;
}

export function mergeDriveSnapshots(...snapshots: DriveSnapshot[]): UnifiedNode[] {
  return snapshots.flatMap((snapshot) => normalizeDriveSnapshot(snapshot));
}

import { describe, expect, it } from 'vitest';
import {
  deriveFileCategory,
  deriveFileExtension,
  deriveIsPreviewable,
  derivePreviewKind,
} from './fileMetadata';

describe('fileMetadata', () => {
  it('derives file extensions from filenames', () => {
    expect(deriveFileExtension('Quarterly.Report.PDF')).toBe('pdf');
    expect(deriveFileExtension('README')).toBeUndefined();
    expect(deriveFileExtension('.env')).toBeUndefined();
  });

  it('classifies files into consistent OmniDrive categories', () => {
    expect(deriveFileCategory('application/pdf', 'Plan.pdf')).toBe('pdfs');
    expect(
      deriveFileCategory(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Plan.docx',
      ),
    ).toBe('documents');
    expect(
      deriveFileCategory(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Budget.xlsx',
      ),
    ).toBe('spreadsheets');
    expect(deriveFileCategory('audio/mpeg', 'Track.mp3')).toBe('audio');
    expect(deriveFileCategory('video/mp4', 'Launch.mp4')).toBe('videos');
    expect(deriveFileCategory('image/png', 'Hero.png')).toBe('images');
    expect(deriveFileCategory('text/markdown', 'notes.md')).toBe('text');
    expect(
      deriveFileCategory('application/vnd.google-apps.document', 'Roadmap'),
    ).toBe('documents');
    expect(
      deriveFileCategory('application/vnd.google-apps.spreadsheet', 'Forecast'),
    ).toBe('spreadsheets');
  });

  it('derives preview kinds for supported formats', () => {
    expect(derivePreviewKind('application/pdf', 'Plan.pdf')).toBe('pdf');
    expect(derivePreviewKind('audio/mpeg', 'Track.mp3')).toBe('audio');
    expect(derivePreviewKind('video/mp4', 'Launch.mp4')).toBe('video');
    expect(derivePreviewKind('image/jpeg', 'Photo.jpg')).toBe('image');
    expect(derivePreviewKind('text/plain', 'notes.txt')).toBe('text');
    expect(
      derivePreviewKind(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Plan.docx',
      ),
    ).toBe('docx');
    expect(
      derivePreviewKind(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Budget.xlsx',
      ),
    ).toBe('xlsx');
    expect(derivePreviewKind('application/vnd.google-apps.document', 'Roadmap')).toBe('docx');
    expect(derivePreviewKind('application/vnd.google-apps.spreadsheet', 'Forecast')).toBe('xlsx');
    expect(derivePreviewKind('application/octet-stream', 'Archive.bin')).toBe('unsupported');
  });

  it('marks only supported formats as previewable', () => {
    expect(deriveIsPreviewable('application/pdf', 'Plan.pdf')).toBe(true);
    expect(deriveIsPreviewable('application/vnd.google-apps.document', 'Roadmap')).toBe(true);
    expect(deriveIsPreviewable('application/zip', 'Archive.zip')).toBe(false);
  });
});

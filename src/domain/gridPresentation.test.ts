import { describe, expect, it } from 'vitest';
import type { BrowseRow } from './browseModel';
import {
  clampGridCardSize,
  gridColumnsStyle,
  thumbnailToneClasses,
} from './gridPresentation';

const baseRow = {
  id: 'row-1',
  kind: 'file',
  name: 'Parallel Computing.pdf',
  virtualPath: '/Parallel Computing.pdf',
  typeLabel: 'PDF',
  sizeBytes: 1024,
  modifiedTime: '2026-04-26T00:00:00.000Z',
  accountLabels: ['A'],
  fileCategory: 'pdfs',
  fileExtension: 'pdf',
  entry: {
    kind: 'node',
    node: {
      id: 'node-1',
      googleId: 'google-1',
      accountId: 'drive-a',
      filename: 'Parallel Computing.pdf',
      isFolder: false,
      sizeBytes: 1024,
      virtualPath: '/Parallel Computing.pdf',
      mimeType: 'application/pdf',
      fileCategory: 'pdfs',
      isPreviewable: true,
    },
  },
} as unknown as BrowseRow;

describe('clampGridCardSize', () => {
  it('keeps grid card size within the supported range', () => {
    expect(clampGridCardSize(100)).toBe(140);
    expect(clampGridCardSize(220)).toBe(220);
    expect(clampGridCardSize(500)).toBe(320);
  });
});

describe('gridColumnsStyle', () => {
  it('builds a responsive minmax grid style from the chosen card size', () => {
    expect(gridColumnsStyle(220)).toEqual({
      gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
    });
  });
});

describe('thumbnailToneClasses', () => {
  it('uses light surfaces for mono light mode thumbnails', () => {
    const result = thumbnailToneClasses(baseRow, 'light', 'mono', true);

    expect(result.surface).toContain('bg-white/95');
    expect(result.surface).toContain('text-slate-700');
    expect(result.iconChip).toContain('bg-slate-900/6');
  });

  it('uses darker surfaces for mono dark mode thumbnails', () => {
    const result = thumbnailToneClasses(baseRow, 'dark', 'mono', true);

    expect(result.surface).toContain('bg-slate-950/95');
    expect(result.surface).toContain('text-slate-100');
  });

  it('keeps gold thumbnails warm in light mode', () => {
    const result = thumbnailToneClasses(baseRow, 'light', 'gold', false);

    expect(result.surface).toContain('from-amber-200/60');
    expect(result.meta).toContain('text-amber-900/70');
  });
});

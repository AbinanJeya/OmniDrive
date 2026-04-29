import { convertFileSrc } from '@tauri-apps/api/core';
import {
  AlertCircle,
  Download,
  FileText,
  LoaderCircle,
  Music4,
  PlaySquare,
  Sheet,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PreviewDescriptor, UnifiedNode } from '../domain/types';

interface FilePreviewProps {
  node: UnifiedNode;
  descriptor: PreviewDescriptor | null;
  isLoading: boolean;
  errorMessage: string | null;
  onBack: () => void;
  onDownload: () => void;
}

function assetUrl(localPath?: string): string | undefined {
  if (!localPath) {
    return undefined;
  }

  return convertFileSrc(localPath);
}

function PreviewBody({
  descriptor,
}: {
  descriptor: PreviewDescriptor;
}) {
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const sourceUrl = useMemo(() => assetUrl(descriptor.localPath), [descriptor.localPath]);

  switch (descriptor.kind) {
    case 'pdf':
      return sourceUrl ? (
        <iframe title={descriptor.filename} src={sourceUrl} className="h-[72vh] w-full rounded-xl border border-cyan-100/10 bg-slate-950" />
      ) : null;
    case 'image':
      return sourceUrl ? (
        <div className="flex min-h-[72vh] items-center justify-center rounded-xl border border-cyan-100/10 bg-slate-950/70 p-6">
          <img src={sourceUrl} alt={descriptor.filename} className="max-h-[68vh] max-w-full rounded-lg object-contain" />
        </div>
      ) : null;
    case 'audio':
      return sourceUrl ? (
        <div className="flex min-h-[72vh] flex-col items-center justify-center gap-6 rounded-xl border border-cyan-100/10 bg-slate-950/70 p-8">
          <Music4 className="h-16 w-16 text-cyan-200" />
          <audio controls className="w-full max-w-3xl">
            <source src={sourceUrl} type={descriptor.mimeType} />
          </audio>
        </div>
      ) : null;
    case 'video':
      return sourceUrl ? (
        <div className="rounded-xl border border-cyan-100/10 bg-black/90 p-4">
          <video controls className="max-h-[72vh] w-full rounded-lg">
            <source src={sourceUrl} type={descriptor.mimeType} />
          </video>
        </div>
      ) : null;
    case 'text':
      return (
        <div className="min-h-[72vh] overflow-auto rounded-xl border border-cyan-100/10 bg-slate-950/70 p-6">
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-slate-200">
            {descriptor.textContent ?? ''}
          </pre>
        </div>
      );
    case 'docx':
      return (
        <div className="min-h-[72vh] rounded-xl border border-cyan-100/10 bg-white p-8 text-slate-900">
          <article
            className="docx-preview prose prose-slate max-w-none"
            dangerouslySetInnerHTML={{ __html: descriptor.htmlContent ?? '' }}
          />
        </div>
      );
    case 'xlsx': {
      const sheets = descriptor.sheets ?? [];
      const activeSheet = sheets[activeSheetIndex];

      return (
        <div className="min-h-[72vh] rounded-xl border border-cyan-100/10 bg-slate-950/70 p-5">
          <div className="mb-4 flex flex-wrap gap-2 border-b border-cyan-100/10 pb-4">
            {sheets.map((sheet, index) => (
              <button
                key={sheet.name}
                type="button"
                onClick={() => setActiveSheetIndex(index)}
                className={[
                  'rounded-full px-3 py-1.5 text-sm font-medium transition',
                  index === activeSheetIndex
                    ? 'bg-cyan-500 text-slate-950'
                    : 'bg-white/5 text-slate-300 hover:bg-white/10',
                ].join(' ')}
              >
                {sheet.name}
              </button>
            ))}
          </div>
          {activeSheet ? (
            <div className="overflow-auto">
              <table className="min-w-full border-collapse">
                <tbody>
                  {activeSheet.rows.map((row, rowIndex) => (
                    <tr key={`${activeSheet.name}:${rowIndex}`} className="border-b border-cyan-100/10">
                      {row.map((cell, cellIndex) => (
                        <td
                          key={`${activeSheet.name}:${rowIndex}:${cellIndex}`}
                          className="min-w-[120px] border-r border-cyan-100/5 px-3 py-2 align-top text-sm text-slate-200"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-slate-400">
              No readable sheets were found in this workbook.
            </div>
          )}
        </div>
      );
    }
    case 'unsupported':
    default:
      return (
        <div className="flex min-h-[72vh] flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-cyan-100/20 bg-slate-950/70 p-8 text-center">
          <AlertCircle className="h-12 w-12 text-cyan-200" />
          <div>
            <p className="text-lg font-semibold text-slate-100">Preview unavailable</p>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">{descriptor.note}</p>
          </div>
        </div>
      );
  }
}

export function FilePreview({
  node,
  descriptor,
  isLoading,
  errorMessage,
  onBack,
  onDownload,
}: FilePreviewProps) {
  return (
    <section className="flex min-h-0 flex-col gap-5">
      <header className="glass-panel gold-gradient rounded-xl p-6 shadow-glow">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <button
              type="button"
              onClick={onBack}
              className="text-xs font-semibold uppercase tracking-[0.24em] text-cyan-200 transition hover:text-cyan-50"
            >
              Back To Files
            </button>
            <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight text-slate-100">
              {node.filename}
            </h2>
            <p className="mt-2 text-sm text-slate-400">{node.virtualPath}</p>
          </div>
          <button
            type="button"
            onClick={onDownload}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-600 to-cyan-500 px-5 py-3 text-sm font-semibold text-white transition hover:shadow-[0_0_18px_rgba(0,240,255,0.28)] active:scale-[0.98]"
          >
            <Download className="h-4 w-4" />
            Download
          </button>
        </div>
      </header>

      {isLoading ? (
        <div className="glass-panel flex min-h-[72vh] items-center justify-center rounded-xl shadow-glow">
          <div className="flex items-center gap-3 text-slate-300">
            <LoaderCircle className="h-5 w-5 animate-spin text-cyan-300" />
            Preparing in-app preview...
          </div>
        </div>
      ) : errorMessage ? (
        <div className="glass-panel flex min-h-[72vh] flex-col items-center justify-center gap-4 rounded-xl p-8 text-center shadow-glow">
          <AlertCircle className="h-12 w-12 text-red-500" />
          <div>
            <p className="text-lg font-semibold text-slate-100">Preview failed</p>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">{errorMessage}</p>
          </div>
        </div>
      ) : descriptor ? (
        <PreviewBody descriptor={descriptor} />
      ) : (
        <div className="glass-panel flex min-h-[72vh] flex-col items-center justify-center gap-4 rounded-xl p-8 text-center shadow-glow">
          <FileText className="h-12 w-12 text-cyan-200" />
          <div>
            <p className="text-lg font-semibold text-slate-100">Preview unavailable</p>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">
              OmniDrive could not prepare this file preview.
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

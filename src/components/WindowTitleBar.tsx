import type { MouseEvent as ReactMouseEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Maximize2, Minus, X } from 'lucide-react';

async function safelyRunWindowAction(action: () => Promise<void>) {
  try {
    await action();
  } catch {
    // Browser-only Vite sessions do not expose desktop window controls.
  }
}

async function toggleWindowMaximize() {
  const window = getCurrentWindow();
  if (await window.isMaximized()) {
    await window.unmaximize();
    return;
  }

  await window.maximize();
}

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(
    target.closest(
      'button, a, input, select, textarea, [role="button"], [data-window-control="true"]',
    ),
  );
}

export function WindowTitleBar() {
  const handleMouseDown = (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0 || isInteractiveTarget(event.target)) {
      return;
    }

    void safelyRunWindowAction(() => getCurrentWindow().startDragging());
  };

  return (
    <header
      data-tauri-drag-region
      className="custom-titlebar flex h-11 shrink-0 select-none items-center justify-between border-b border-cyan-100/10 bg-[#051527]/95 px-3 text-slate-100 shadow-[0_12px_36px_rgba(0,0,0,0.2)] backdrop-blur-2xl"
      onMouseDown={handleMouseDown}
      onDoubleClick={() => {
        void safelyRunWindowAction(() => toggleWindowMaximize());
      }}
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-3">
        <span className="titlebar-brand-mark flex h-6 w-6 items-center justify-center rounded-lg">
          <span className="titlebar-brand-core h-2.5 w-2.5 rounded-sm bg-[#061322]" />
        </span>
        <div data-tauri-drag-region className="min-w-0">
          <p className="truncate text-sm font-semibold tracking-wide text-slate-100">OmniDrive</p>
        </div>
      </div>

      <nav className="flex items-center gap-1" aria-label="Window controls">
        <button
          type="button"
          className="titlebar-button"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          data-window-control="true"
          aria-label="Minimize window"
          onClick={() => {
            void safelyRunWindowAction(() => getCurrentWindow().minimize());
          }}
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="titlebar-button"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          data-window-control="true"
          aria-label="Maximize window"
          onClick={() => {
            void safelyRunWindowAction(() => toggleWindowMaximize());
          }}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="titlebar-button titlebar-button-danger"
          onMouseDown={(event) => {
            event.stopPropagation();
          }}
          data-window-control="true"
          aria-label="Close window"
          onClick={() => {
            void safelyRunWindowAction(() => getCurrentWindow().close());
          }}
        >
          <X className="h-4 w-4" />
        </button>
      </nav>
    </header>
  );
}

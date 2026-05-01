# OmniDrive Project Context

This is the main handoff file for OmniDrive. It is meant to let a future agent, editor, or IDE pick up the project without needing the conversation history.

## What OmniDrive Is

OmniDrive is a desktop-first Google Drive workspace built with React, TypeScript, Vite, and Tauri. It combines multiple Google Drive accounts into one file browser, with previews, transfers, cleanup tools, and local account-aware storage views.

The app has a private OmniDrive sign-in layer in front of the workspace. Users must sign in to OmniDrive before they can see linked Drive accounts or local workspace data.

## Current Product Shape

- One desktop app, not a web-only SaaS.
- OmniDrive auth unlocks the workspace.
- Google Drive linking happens after OmniDrive sign-in.
- Google OAuth tokens are stored locally in the OS keyring.
- The app keeps a local index plus cloud-linked metadata for account registry sync.
- Right-click menus, file details, and drag/drop all use a custom glass UI.

## Core User Flows

1. Open the app and sign in to OmniDrive.
2. Verify email if needed.
3. Connect one or more Google Drive accounts.
4. Browse files and folders in list or grid mode.
5. Preview files, download, share, rename, delete, and transfer between drives.
6. Use cleanup and storage views to inspect large files, duplicates, and job status.
7. Sign out to return to the locked shell and clear workspace state.

## Important Recent Behavior

The current UI and interaction work focused on:

- drag and drop transfer between connected drives
- pointer-driven drag preview that follows the mouse smoothly
- right-click Transfer submenu that stays open and works for files and folders
- custom transfer chooser popup for toolbar/details/context menu
- unified glass styling, rounded hover states, and reduced clutter
- account-scoped storage summaries that avoid double-counting likely shared Google family storage

## Architecture Overview

### Frontend

- `src/App.tsx` is the main shell and state coordinator.
- `src/components/` contains the main visual pieces:
  - `DriveSidebar`
  - `DriveGrid`
  - `DriveTable`
  - `FilePreview`
  - `WindowTitleBar`
  - `FileExplorer`
- `src/domain/` holds pure data and presentation logic:
  - routing
  - browse row computation
  - storage summaries
  - duplicate cleanup
  - transfer planning
  - drag preview presentation
  - file metadata normalization
- `src/lib/` wraps backend and auth helpers:
  - Supabase auth
  - Google auth
  - cloud account sync
  - Tauri invoke wrappers
  - local error normalization

### Backend

- `src-tauri/` is the Rust Tauri backend.
- It owns Google OAuth flows, secure token storage, local index access, Drive mutations, and desktop session gating.
- The backend enforces that sensitive desktop commands only run when an OmniDrive session is active.

## Key Files

- [`src/App.tsx`](src/App.tsx): main app shell and most interactions
- [`src/domain/browseModel.ts`](src/domain/browseModel.ts): converts nodes into browse rows
- [`src/domain/driveView.ts`](src/domain/driveView.ts): account/storage summaries
- [`src/domain/transferModel.ts`](src/domain/transferModel.ts): transfer planning and folder expansion
- [`src/domain/dragPresentation.ts`](src/domain/dragPresentation.ts): drag preview positioning
- [`src/lib/driveBackend.ts`](src/lib/driveBackend.ts): frontend/backend bridge for Drive and transfer commands
- [`src/lib/authClient.ts`](src/lib/authClient.ts): Supabase auth helpers
- [`src/lib/cloudAccounts.ts`](src/lib/cloudAccounts.ts): cloud-linked account registry sync
- [`src-tauri/src/main.rs`](src-tauri/src/main.rs): Tauri command surface
- [`src-tauri/src/drive_mutations.rs`](src-tauri/src/drive_mutations.rs): Drive mutation behavior
- [`src-tauri/src/oauth.rs`](src-tauri/src/oauth.rs): OAuth helpers

## Environment Variables

The local `.env.example` includes:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
VITE_TURNSTILE_SITE_KEY=
NEXT_PUBLIC_TURNSTILE_SITE_KEY=
VITE_GOOGLE_CLIENT_ID=
NEXT_PUBLIC_GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

Notes:

- `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are the primary frontend vars.
- `NEXT_PUBLIC_*` aliases were also supported during setup for convenience.
- `VITE_TURNSTILE_SITE_KEY` is used for signup/login security checks.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are local desktop OAuth credentials.

## Build And Run

From the repo root:

```bash
npm install
npm run dev
npm run build
npm run tauri:dev
npm run package:windows
npm run package:linux
```

## Tests That Matter

Useful focused checks:

```bash
cmd /c npx vitest run src/domain/transferModel.test.ts src/domain/dragPresentation.test.ts src/lib/driveBackend.test.ts
cmd /c npm run build
```

The repo also has tests around:

- auth
- transfer planning
- folder/file browse modeling
- duplicate cleanup
- storage summaries
- route parsing

## Current Product Constraints

- The workspace must remain hidden while locked.
- Google Drive metadata and local workspace data are per OmniDrive user.
- Tokens stay local in the OS keyring.
- The app should not auto-attach old device-wide Google data to a new OmniDrive user.
- Google Photos support is limited and remains more constrained than Drive.
- Folder transfers are implemented by expanding to file items; the backend still works in terms of Drive files.
- Google family/shared storage is estimated with heuristics because Drive does not expose a clean family id.

## Release And Packaging

- `src-tauri/tauri.conf.json` is configured for desktop bundles.
- Windows uses a custom OmniDrive installer, not the default generic installer experience.
- GitHub Actions build desktop bundles from `main`.
- The public website assets live separately from the desktop app UI, but screenshots are stored in `docs/screenshots/`.

## Where To Look First When Resuming

1. Open `src/App.tsx` to see the current interaction state.
2. Check `src/domain/transferModel.ts` and `src/domain/dragPresentation.ts` for transfer behavior.
3. Check `src/components/DriveSidebar.tsx`, `src/components/DriveGrid.tsx`, and `src/components/DriveTable.tsx` for the browsing surface.
4. Check `src/lib/driveBackend.ts` and the Rust commands when a feature touches Drive, auth, or transfer behavior.
5. Run `npm run build` and the focused Vitest files before trusting a change.

## Current Worktree Notes

There are often unrelated dirty files in the local working tree, especially generated Tauri schema files and some auth test noise. Do not revert unrelated changes unless the user explicitly asks.

## Recent Feature History

Recent work has added:

- Supabase-gated OmniDrive access
- email/password sign-up, sign-in, verification, and sign-out
- Cloudflare Turnstile protection
- Google OAuth sign-in path with captcha token support
- linked account registry sync through Supabase
- user-scoped local account namespaces
- custom installer UI
- transfer actions in file details and right-click menus
- drag/drop transfer to other drives
- smoother drag preview motion
- improved README and screenshots

## Important Caveats

- In-app browser Turnstile can be rejected even when a normal browser works.
- Supabase table setup for linked account sync required running the provided SQL manually.
- Browser-only sessions do not have the same desktop keyring/tauri capabilities as the Tauri app.
- The current browser-facing workspace may not be fully functional for every Drive action unless the required desktop runtime is present.

## If You Need A Single Sentence

OmniDrive is a Tauri desktop app that unlocks a private multi-drive Google workspace behind OmniDrive auth, then lets the user browse, preview, transfer, and manage Drive data with a polished glass UI while keeping account data local and separated per user.

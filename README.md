# OmniDrive

OmniDrive is a Tauri desktop app that lets you browse multiple Google Drive accounts from one unified workspace.

It combines:
- a `React + TypeScript + Tailwind` frontend
- a `Rust + Tauri` desktop backend
- secure token storage through the OS keyring
- local indexing for faster browsing, previews, jobs, and storage insights

## What It Does

- Connect multiple Google Drive accounts
- Browse `All Drives` as one merged view
- Switch into each linked drive individually
- Upload, download, rename, delete, transfer, and share files
- Preview common file types inside the app
- View aggregated storage usage
- Surface cleanup insights like duplicate candidates and low-space warnings

## Stack

- Frontend: `React`, `TypeScript`, `Vite`, `Tailwind CSS`
- Desktop shell: `Tauri 2`
- Backend: `Rust`
- Storage: OS-native keyring + local SQLite index
- APIs: `Google Drive API`, limited `Google Photos` picker flow

## Project Structure

```text
src/           React app, browsing UI, theme system, domain logic
src-tauri/     Rust backend, OAuth, Drive API integration, local index
Website/       Public GitHub Pages marketing/download site
.github/       GitHub Actions workflows
```

## Local Development

Install dependencies:

```bash
npm install
```

Run the frontend only:

```bash
npm run dev
```

Run the desktop app:

```bash
npm run tauri:dev
```

Build the web frontend:

```bash
npm run build
```

## Desktop Packaging

Windows installer:

```bash
npm run package:windows
```

The Windows package uses a branded NSIS installer with OmniDrive header/sidebar artwork, an OmniDrive Start Menu folder, and finish-page options to add a Desktop shortcut and launch OmniDrive after setup.

Linux bundles:

```bash
npm run package:linux
```

Cross-platform bundle command:

```bash
npm run package:desktop
```

## Environment

Create a local `.env` file from `.env.example` and add your Google OAuth desktop client values.

Example:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-supabase-publishable-or-anon-key
VITE_TURNSTILE_SITE_KEY=your-cloudflare-turnstile-site-key
VITE_GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
```

`VITE_TURNSTILE_SITE_KEY` is optional until CAPTCHA protection is enabled in Supabase Auth. To make the signup CAPTCHA functional, enable CAPTCHA protection in the Supabase dashboard with Cloudflare Turnstile and put the public site key in this env value.

## GitHub Releases

This repo includes a GitHub Actions release workflow that currently builds:

- Windows `NSIS`
- Linux `AppImage`, `deb`, and `rpm`

## GitHub Pages Site

The public landing page is served from the `Website/` folder through GitHub Actions.

## Current Notes

- Google Drive support is the main production path
- Google Photos support is limited by Google's picker/session constraints
- macOS signing and notarization are not configured yet

## License

No license has been added yet.

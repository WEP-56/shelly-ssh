# Shelly SSH

Shelly is a Windows-first SSH/SFTP desktop client built with Tauri, React, and Rust.

The project focuses on a smooth terminal workflow, practical SFTP file operations, host key safety, and lightweight server-side assistance tools.

## Features

- SSH terminal with saved device management.
- Password and private-key authentication.
- Host key trust prompts and known-host lifecycle management.
- SFTP file browser with upload, download, rename, delete, directory upload, conflict handling, and transfer jobs.
- Command history, snippets, and a command palette for long-command editing.
- Device status display for memory, storage, load, uptime, and system details.
- Local terminal and agent-side workflow panels loaded on demand.
- Fast Tauri dev startup through prebuilt frontend preview mode.

## Development

Prerequisites:

- Node.js 22+
- Rust stable
- Windows WebView2 runtime

Install dependencies:

```powershell
npm ci
```

Run the Tauri app for normal integration testing:

```powershell
npm run dev:tauri
npx tauri dev
```

Run the frontend Vite dev server directly:

```powershell
npm run dev
```

Build checks:

```powershell
npm run build
cd src-tauri
cargo check
```

## Release

Windows release packaging is handled by GitHub Actions when a version tag is pushed:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

The workflow creates a draft GitHub Release with Windows artifacts.

## License

MIT

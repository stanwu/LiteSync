# LiteSync

Lightweight CouchDB sync plugin for Obsidian. Compatible with [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) database format.

## Why

Self-hosted LiveSync crashes on older Obsidian/Electron versions (SIGSEGV in V8 JIT). LiteSync is a ~400 line ES2017 alternative that works on Obsidian 1.1.16+ (macOS 10.14 Mojave).

## Features

- **Bidirectional sync** with CouchDB (pull/push)
- **Real-time sync** via Obsidian vault events (modify, delete, rename, create)
- **Compatible** with Self-hosted LiveSync database format
- **Status bar** showing sync state
- **Settings UI** for CouchDB connection
- **Commands** (Cmd+P): Sync now, Pull, Push, Show status
- **~400 lines** ES2017 — no build step, no transpiler

## Requirements

- Obsidian (any version, tested on 1.1.16+)
- CouchDB 3.x with a Self-hosted LiveSync database
- Network access to CouchDB (e.g. via Tailscale)

## Installation

1. Copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/litesync/`
2. Enable "LiteSync" in Obsidian Settings → Community Plugins
3. Configure CouchDB connection in Settings → LiteSync

## Configuration

| Setting | Description |
|---------|-------------|
| Server URI | CouchDB URL (e.g. `https://your-server/couchdb`) |
| Username | CouchDB admin username |
| Password | CouchDB admin password |
| Database name | Default: `obsidianlivesync` |
| Auto sync | Enable real-time sync on file changes |
| Sync interval | Periodic sync in seconds (0 = manual only) |
| Device name | Identifies this device in sync |

## CLI Tools (included)

For headless/scripted sync (e.g. cron jobs):

```bash
node livesync-cli.mjs status          # Show DB info
node livesync-cli.mjs fetch           # Full download from DB
node livesync-sync.mjs sync           # Bidirectional sync
node livesync-sync.mjs prune          # Remove zombie docs
node livesync-sync.mjs push --dry-run # Preview push
```

### CLI Environment Variables

```bash
export LIVESYNC_URI="https://your-server/couchdb"
export LIVESYNC_USER="admin"
export LIVESYNC_PASS="your-password"
export LIVESYNC_DB="obsidianlivesync"
export VAULT_PATH="$HOME/your-vault"
```

## How It Works

LiteSync reads/writes the same CouchDB database format as Self-hosted LiveSync:

- **File documents** (`f:` prefix): path, mtime, size, children (chunk IDs)
- **Chunk documents** (`h:` prefix): text content, type `leaf`
- File content = ordered concatenation of children chunks

The CLI also includes:
- **Manifest-based change detection** (`.livesync-manifest.json`)
- **inode-based move/rename detection** (no content re-upload)
- **Directory mtime optimization** for fast scanning
- **Zombie cleanup** (prune + CouchDB compaction)

## License

MIT

# LiteSync

Lightweight CouchDB sync plugin for Obsidian. Compatible with [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) database format.

## The Story

I have a 2010 MacBook Air with 2GB RAM running macOS 10.14 Mojave. It is lightweight and portable for me for note-taking daily life.

I had been using iCloud to sync my Obsidian vault, and it worked fine — on Apple devices. Two things pushed me to look for an alternative: first, my 2010 MacBook Air couldn't support iCloud's end-to-end encryption, blocking E2EE across all my Apple devices — so iCloud sync was already compromised; second, I wanted to keep my options open for cross-platform sync in the future — I'd rather not be locked into any single ecosystem.

I found [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) — a brilliant project that syncs Obsidian vaults through a self-hosted CouchDB server. It works perfectly on my other Apple devices, and I still use it there. Once I moved Obsidian sync off iCloud, I could disconnect the MacBook Air from iCloud entirely — and all my other Apple devices could finally enable iCloud E2EE for everything else.

But LiveSync is a complex plugin optimized for modern Electron, and my 2010 MacBook Air with only 2GB RAM struggled with it. So with Claude's help, I decided to write a lightweight alternative that reads and writes the exact same CouchDB database.

900 lines of ES2017. No build step. No transpiler. No dependencies. LiteSync runs on the MacBook Air, LiveSync runs on everything else — and they share the same database seamlessly.

It worked on the first try.

## Why Share This

LiveSync is an incredible piece of engineering. I'm not trying to replace it — if it works for you, keep using it. I still use it myself on my other devices.

But if you're stuck on an older machine, or if you just want a sync plugin simple enough to read in one sitting — LiteSync is here.

It's also a clean reference implementation of the LiveSync database format. The entire codebase fits in a single file. Fork it, modify it, learn from it.

## Features

- **Bidirectional sync** with CouchDB (newer wins)
- **Pull** — remote to local only
- **Push** — local to remote only
- **Fetch** — full download for first-time setup
- **Prune** — remove zombie docs from DB (with confirmation modal)
- **Periodic sync** — configurable timer with toggle switch
- **Binary file support** — images, PDFs, etc. via base64
- **Compatible** with Self-hosted LiveSync database format (SHA-256 path obfuscation)
- **Status bar** showing sync state
- **~900 lines** ES2017 — no build step, no transpiler

## Requirements

- Obsidian (any version, tested on 1.1.16+)
- CouchDB 3.x with a Self-hosted LiveSync database
- Network access to CouchDB (e.g. via Tailscale)

## Installation

1. Copy `main.js`, `manifest.json`, `styles.css` to `.obsidian/plugins/litesync/`
2. Enable "LiteSync" in Obsidian Settings → Community Plugins
3. Configure CouchDB connection in Settings → LiteSync

## Commands

All commands available via `Cmd/Ctrl + P`:

| Command | Description |
|---------|-------------|
| Sync now | Bidirectional sync (newer wins) |
| Pull from remote | Remote → Local only |
| Push to remote | Local → Remote only |
| Fetch (full download) | Download all files from DB |
| Prune zombie docs | Remove orphaned docs from DB |
| Show sync status | Display DB info |

## Configuration

| Setting | Description |
|---------|-------------|
| Server URI | CouchDB URL (e.g. `https://your-server/couchdb`) |
| Username | CouchDB admin username |
| Password | CouchDB admin password |
| Database name | CouchDB database name |
| Passphrase | Must match Self-hosted LiveSync passphrase for path obfuscation |
| Device name | Identifies this device in sync |
| Enable periodic sync | Toggle for automatic sync timer |
| Sync interval | Seconds between syncs (default: 300) |

## CLI Tools (included)

For headless/scripted sync (e.g. cron jobs):

```bash
node livesync-cli.mjs status          # Show DB info
node livesync-cli.mjs fetch           # Full download from DB
node livesync-sync.mjs sync           # Bidirectional sync
node livesync-sync.mjs pull           # Remote → Local
node livesync-sync.mjs push           # Local → Remote
node livesync-sync.mjs prune          # Remove zombie docs
node livesync-sync.mjs push --dry-run # Preview push
```

### CLI Environment Variables

```bash
export LIVESYNC_URI="https://your-server/couchdb"
export LIVESYNC_USER="your-username"
export LIVESYNC_PASS="your-password"
export LIVESYNC_DB="your-database-name"
export LIVESYNC_PASSPHRASE="your-passphrase"
export VAULT_PATH="$HOME/your-vault"
```

## How It Works

LiteSync reads/writes the same CouchDB database format as Self-hosted LiveSync:

- **File documents** (`f:` prefix): path, mtime, size, children (chunk IDs)
- **Chunk documents** (`h:` prefix): text content, type `leaf`
- File content = ordered concatenation of children chunks
- **Path obfuscation**: SHA-256 based, compatible with LiveSync passphrase

The CLI also includes:
- **Manifest-based change detection** (`.livesync-manifest.json`)
- **inode-based move/rename detection** (no content re-upload)
- **Directory mtime optimization** for fast scanning
- **Zombie cleanup** (prune + CouchDB compaction)

## License

MIT

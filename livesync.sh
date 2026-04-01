#!/bin/bash
# LiveSync CLI wrapper
# Usage: ~/livesync.sh [status|pull|push|sync|prune|fetch] [--dry-run]

# Configure these environment variables before use:
# export LIVESYNC_URI="https://your-server/couchdb"
# export LIVESYNC_USER="your-username"
# export LIVESYNC_PASS="your-password"
# export LIVESYNC_DB="your-db-name"
# export VAULT_PATH="/path/to/your/vault"

CMD="${1:-status}"

case "$CMD" in
  fetch)
    shift
    node ~/livesync-cli.mjs fetch "$@"
    ;;
  status|pull|push|sync|prune)
    shift
    node ~/livesync-sync.mjs "$CMD" "$@"
    ;;
  *)
    echo "Usage: ~/livesync.sh <status|pull|push|sync|prune|fetch> [--dry-run]"
    echo ""
    echo "  status  - Show database info"
    echo "  pull    - Remote → Local"
    echo "  push    - Local → Remote"
    echo "  sync    - Bidirectional (newer wins)"
    echo "  prune   - Remove zombie docs from DB"
    echo "  fetch   - Full download from DB (first-time)"
    ;;
esac

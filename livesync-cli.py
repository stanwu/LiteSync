#!/usr/bin/env python3
"""
LiveSync CLI - Fetch Obsidian vault from CouchDB (Self-hosted LiveSync)
Compatible with LiveSync 0.23.x / 0.25.x database format.

Usage:
    python3 livesync-cli.py fetch    # Download vault from CouchDB
    python3 livesync-cli.py status   # Show database info
    python3 livesync-cli.py list     # List all files in remote DB
"""

import json
import os
import sys
import time
import base64
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from urllib.parse import quote

# === Configuration (via environment variables) ===
COUCHDB_URI = os.environ.get("LIVESYNC_URI", "")
COUCHDB_USER = os.environ.get("LIVESYNC_USER", "")
COUCHDB_PASSWORD = os.environ.get("LIVESYNC_PASS", "")
COUCHDB_DBNAME = os.environ.get("LIVESYNC_DB", "")
VAULT_PATH = os.environ.get("VAULT_PATH", os.path.expanduser("~/livesync-vault"))
BATCH_SIZE = 200  # docs per request

if not COUCHDB_URI or not COUCHDB_USER or not COUCHDB_PASSWORD or not COUCHDB_DBNAME:
    print("Error: Set LIVESYNC_URI, LIVESYNC_USER, LIVESYNC_PASS, LIVESYNC_DB environment variables.")
    sys.exit(1)

# === HTTP Helper ===
def couchdb_request(path, method="GET"):
    url = f"{COUCHDB_URI}/{COUCHDB_DBNAME}/{path}"
    credentials = base64.b64encode(f"{COUCHDB_USER}:{COUCHDB_PASSWORD}".encode()).decode()
    req = Request(url, method=method)
    req.add_header("Authorization", f"Basic {credentials}")
    req.add_header("Content-Type", "application/json")
    try:
        with urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except HTTPError as e:
        print(f"  HTTP Error {e.code}: {url}")
        return None
    except URLError as e:
        print(f"  Connection Error: {e.reason}")
        return None

def couchdb_bulk_get(doc_ids):
    """Fetch multiple documents in one request."""
    url = f"{COUCHDB_URI}/{COUCHDB_DBNAME}/_bulk_get"
    credentials = base64.b64encode(f"{COUCHDB_USER}:{COUCHDB_PASSWORD}".encode()).decode()
    body = json.dumps({"docs": [{"id": did} for did in doc_ids]}).encode()
    req = Request(url, data=body, method="POST")
    req.add_header("Authorization", f"Basic {credentials}")
    req.add_header("Content-Type", "application/json")
    try:
        with urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except (HTTPError, URLError) as e:
        print(f"  Bulk get error: {e}")
        return None

# === Fetch all file documents ===
def fetch_all_file_docs():
    """Fetch all file metadata documents (f: prefix)."""
    print("Fetching file list from CouchDB...")
    all_docs = []
    startkey = quote('"f:"')
    endkey = quote('"f:\ufff0"')
    skip = 0

    while True:
        path = f'_all_docs?include_docs=true&startkey={startkey}&endkey={endkey}&limit={BATCH_SIZE}&skip={skip}'
        data = couchdb_request(path)
        if not data or "rows" not in data:
            break
        rows = data["rows"]
        if not rows:
            break
        all_docs.extend(rows)
        skip += len(rows)
        print(f"  Fetched {len(all_docs)} file entries...")
        if len(rows) < BATCH_SIZE:
            break

    return all_docs

# === Fetch chunks and reconstruct file content ===
def fetch_file_content(doc):
    """Fetch all chunks for a file and reconstruct content."""
    children = doc.get("children", [])
    if not children:
        return ""

    # Bulk fetch all chunks
    result = couchdb_bulk_get(children)
    if not result:
        return None

    # Build chunk map
    chunk_map = {}
    for item in result.get("results", []):
        for doc_item in item.get("docs", []):
            if "ok" in doc_item:
                chunk_doc = doc_item["ok"]
                chunk_map[chunk_doc["_id"]] = chunk_doc.get("data", "")

    # Reconstruct in order
    parts = []
    for child_id in children:
        if child_id in chunk_map:
            parts.append(chunk_map[child_id])
        else:
            print(f"  Warning: Missing chunk {child_id}")
    return "".join(parts)

# === Commands ===
def cmd_status():
    """Show database status."""
    data = couchdb_request("")
    if not data:
        print("Cannot connect to CouchDB")
        return
    print(f"Database:   {data['db_name']}")
    print(f"Documents:  {data['doc_count']}")
    print(f"Deleted:    {data['doc_del_count']}")
    print(f"Size:       {data['sizes']['file'] // 1024 // 1024} MB")

def cmd_list():
    """List all files in the remote database."""
    docs = fetch_all_file_docs()
    files = []
    for row in docs:
        doc = row["doc"]
        path = doc.get("path", "")
        size = doc.get("size", 0)
        ftype = doc.get("type", "?")
        files.append((path, size, ftype))

    files.sort(key=lambda x: x[0])
    print(f"\nTotal: {len(files)} files\n")
    for path, size, ftype in files:
        size_str = f"{size:>8,}" if size else "       ?"
        print(f"  {size_str}  {path}")

def cmd_fetch(dry_run=False):
    """Fetch all files from CouchDB and write to vault."""
    docs = fetch_all_file_docs()
    total = len(docs)
    print(f"\nFound {total} files in remote database.")

    if dry_run:
        print("(Dry run - no files will be written)")

    # Separate text files and binary files
    text_files = []
    binary_files = []
    for row in docs:
        doc = row["doc"]
        ftype = doc.get("type", "")
        if ftype in ("plain", "newnote"):
            path = doc.get("path", "")
            if path.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp3", ".mp4", ".zip")):
                binary_files.append(doc)
            else:
                text_files.append(doc)
        else:
            text_files.append(doc)

    print(f"  Text files:   {len(text_files)}")
    print(f"  Binary files: {len(binary_files)}")
    print()

    # Process text files
    success = 0
    errors = 0
    skipped = 0

    for i, doc in enumerate(text_files):
        path = doc.get("path", "")
        if not path:
            continue

        full_path = os.path.join(VAULT_PATH, path)
        children = doc.get("children", [])

        # Skip if local file exists and same size
        if os.path.exists(full_path):
            local_size = os.path.getsize(full_path)
            remote_size = doc.get("size", -1)
            if local_size == remote_size:
                skipped += 1
                continue

        progress = f"[{i+1}/{len(text_files)}]"
        print(f"  {progress} {path}", end="", flush=True)

        if dry_run:
            print(" (skip)")
            continue

        content = fetch_file_content(doc)
        if content is None:
            print(" ERROR")
            errors += 1
            continue

        # Write file
        try:
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "w", encoding="utf-8") as f:
                f.write(content)
            print(f" OK ({len(content)} bytes)")
            success += 1
        except Exception as e:
            print(f" ERROR: {e}")
            errors += 1

    # Process binary files
    for i, doc in enumerate(binary_files):
        path = doc.get("path", "")
        if not path:
            continue

        full_path = os.path.join(VAULT_PATH, path)

        # Skip if exists and same size
        if os.path.exists(full_path):
            local_size = os.path.getsize(full_path)
            remote_size = doc.get("size", -1)
            if local_size == remote_size:
                skipped += 1
                continue

        progress = f"[{i+1}/{len(binary_files)}]"
        print(f"  {progress} (bin) {path}", end="", flush=True)

        if dry_run:
            print(" (skip)")
            continue

        content = fetch_file_content(doc)
        if content is None:
            print(" ERROR")
            errors += 1
            continue

        # Binary files are base64 encoded in LiveSync
        try:
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            # Try base64 decode for binary
            if content.startswith("data:"):
                # data URI format: data:image/png;base64,xxxx
                _, encoded = content.split(",", 1)
                raw = base64.b64decode(encoded)
                with open(full_path, "wb") as f:
                    f.write(raw)
            else:
                # Try raw base64
                try:
                    raw = base64.b64decode(content)
                    with open(full_path, "wb") as f:
                        f.write(raw)
                except Exception:
                    # Fallback: write as text
                    with open(full_path, "w", encoding="utf-8") as f:
                        f.write(content)
            print(f" OK")
            success += 1
        except Exception as e:
            print(f" ERROR: {e}")
            errors += 1

    print(f"\n=== Done ===")
    print(f"  Success: {success}")
    print(f"  Skipped: {skipped} (same size)")
    print(f"  Errors:  {errors}")

# === Main ===
if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "status":
        cmd_status()
    elif cmd == "list":
        cmd_list()
    elif cmd == "fetch":
        dry_run = "--dry-run" in sys.argv
        cmd_fetch(dry_run=dry_run)
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)

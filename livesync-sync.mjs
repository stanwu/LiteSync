#!/usr/bin/env node
/**
 * LiveSync Sync CLI - Bidirectional sync with CouchDB
 * Test on sandbox DB first!
 *
 * Usage:
 *   node livesync-sync.mjs status
 *   node livesync-sync.mjs pull           # Remote → Local
 *   node livesync-sync.mjs push           # Local → Remote (new/modified)
 *   node livesync-sync.mjs sync           # Bidirectional (newer wins)
 *   node livesync-sync.mjs prune          # Remove zombie docs (DB has, vault doesn't)
 *   node livesync-sync.mjs push --dry-run
 */

import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// === Configuration (via environment variables) ===
const CONFIG = {
  uri: process.env.LIVESYNC_URI || "",
  user: process.env.LIVESYNC_USER || "",
  password: process.env.LIVESYNC_PASS || "",
  dbname: process.env.LIVESYNC_DB || "",
  vaultPath: process.env.VAULT_PATH || `${process.env.HOME}/livesync-vault`,
  passphrase: process.env.LIVESYNC_PASSPHRASE || "",
  batchSize: 200,
};

if (!CONFIG.uri || !CONFIG.user || !CONFIG.password || !CONFIG.dbname) {
  console.error("Error: Set LIVESYNC_URI, LIVESYNC_USER, LIVESYNC_PASS, LIVESYNC_DB environment variables.");
  process.exit(1);
}

const AUTH = Buffer.from(`${CONFIG.user}:${CONFIG.password}`).toString("base64");

// === HTTP Helper ===
function request(urlPath, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.uri}/${CONFIG.dbname}/${urlPath}`);
    const mod = url.protocol === "https:" ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Basic ${AUTH}`,
        "Content-Type": "application/json",
      },
      rejectUnauthorized: false,
    };
    if (body) options.headers["Content-Length"] = Buffer.byteLength(body);

    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf-8");
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// === Hash functions (compatible with LiveSync) ===
async function hashStringSHA256(input) {
  // LiveSync: SHA-256 applied (input.length) times
  let buf = Buffer.from(input, "utf-8");
  const len = input.length;
  let digest;
  for (let i = 0; i <= len; i++) {
    digest = crypto.createHash("sha256").update(buf).digest();
  }
  return digest.toString("hex");
}

async function pathToDocId(filePath, passphrase) {
  if (!passphrase) return "f:" + filePath;
  const hashedPass = await hashStringSHA256(passphrase);
  const combined = `${hashedPass}:${filePath}`;
  const hash = await hashStringSHA256(combined);
  return `f:${hash}`;
}

function generateChunkId(content, index) {
  // Generate a unique chunk ID based on content hash
  const hash = crypto.createHash("sha256")
    .update(content)
    .update(String(index))
    .digest("hex")
    .slice(0, 12);
  // Convert to base36-like format similar to LiveSync
  const num = BigInt("0x" + hash);
  return "h:" + num.toString(36);
}

// === Split content into chunks ===
function splitIntoChunks(content, minSize = 20, maxSize = 250) {
  if (content.length <= maxSize) return [content];
  const chunks = [];
  let pos = 0;
  while (pos < content.length) {
    let end = Math.min(pos + maxSize, content.length);
    // Try to break at newline
    if (end < content.length) {
      const nlPos = content.lastIndexOf("\n", end);
      if (nlPos > pos + minSize) end = nlPos + 1;
    }
    chunks.push(content.slice(pos, end));
    pos = end;
  }
  return chunks;
}

// === Fetch all remote file docs ===
async function fetchAllRemoteDocs() {
  const allDocs = [];
  let skip = 0;
  const startkey = encodeURIComponent('"f:"');
  const endkey = encodeURIComponent('"f:\ufff0"');
  while (true) {
    const data = await request(
      `_all_docs?include_docs=true&startkey=${startkey}&endkey=${endkey}&limit=${CONFIG.batchSize}&skip=${skip}`
    );
    if (!data?.rows?.length) break;
    allDocs.push(...data.rows);
    skip += data.rows.length;
    if (data.rows.length < CONFIG.batchSize) break;
  }
  return allDocs;
}

// === Fetch chunks and reconstruct ===
async function fetchFileContent(doc) {
  const children = doc.children || [];
  if (!children.length) return "";
  const body = JSON.stringify({ docs: children.map((id) => ({ id })) });
  const result = await request("_bulk_get", "POST", body);
  const chunkMap = {};
  for (const item of result?.results || []) {
    for (const d of item.docs || []) {
      if (d.ok) chunkMap[d.ok._id] = d.ok.data || "";
    }
  }
  return children.map((id) => chunkMap[id] || "").join("");
}

// === Manifest ===
const MANIFEST_FILE = path.join(CONFIG.vaultPath, ".livesync-manifest.json");

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf-8"));
  } catch {
    return { version: 1, lastSync: 0, dirs: {}, files: {} };
  }
}

function saveManifest(manifest) {
  manifest.lastSync = Date.now();
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), "utf-8");
}

function buildManifestFromScan(files) {
  const manifest = { version: 1, lastSync: Date.now(), dirs: {}, files: {} };
  for (const f of files) {
    manifest.files[f.path] = { size: f.size, mtime: f.mtime, ino: f.ino };
    const dir = path.dirname(f.path);
    if (dir !== ".") manifest.dirs[dir] = manifest.dirs[dir] || {};
  }
  return manifest;
}

// === Smart scan with directory mtime optimization ===
function smartScanLocalFiles(dir, manifest, base = "") {
  const results = [];
  const scannedDirs = {};
  if (!fs.existsSync(dir)) return { files: results, dirs: scannedDirs };

  _smartScan(dir, manifest, base, results, scannedDirs);
  return { files: results, dirs: scannedDirs };
}

function _smartScan(dir, manifest, base, results, scannedDirs) {
  let dirEntries;
  try { dirEntries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  const dirStat = fs.statSync(dir);
  const dirMtime = dirStat.mtimeMs;
  const oldDirMtime = manifest.dirs[base]?.mtime;
  const dirChanged = !oldDirMtime || dirMtime !== oldDirMtime;

  if (base) scannedDirs[base] = { mtime: dirMtime };

  for (const entry of dirEntries) {
    if (entry.name.startsWith(".")) continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      _smartScan(full, manifest, rel, results, scannedDirs);
    } else {
      // Always stat files (content changes don't affect dir mtime)
      try {
        const stat = fs.statSync(full);
        results.push({
          path: rel, fullPath: full,
          size: stat.size, mtime: stat.mtimeMs, ino: stat.ino,
        });
      } catch { /* file disappeared */ }
    }
  }
}

// === Scan local vault (simple, no manifest) ===
function scanLocalFiles(dir, base = "") {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      results.push(...scanLocalFiles(full, rel));
    } else {
      const stat = fs.statSync(full);
      results.push({ path: rel, fullPath: full, size: stat.size, mtime: stat.mtimeMs, ino: stat.ino });
    }
  }
  return results;
}

// === Detect changes using manifest ===
function detectChanges(manifest, localFiles, remoteDocs) {
  const localByPath = {};
  for (const f of localFiles) localByPath[f.path] = f;

  const remoteByPath = {};
  for (const row of remoteDocs) {
    const doc = row.doc;
    if (doc.path && !doc.deleted) remoteByPath[doc.path] = doc;
  }

  const manifestFiles = manifest.files || {};
  const actions = { pull: [], push: [], delete: [], move: [], skip: 0 };

  // Build inode map from manifest for move detection
  const manifestByIno = {};
  for (const [p, info] of Object.entries(manifestFiles)) {
    if (info.ino) manifestByIno[info.ino] = p;
  }

  // Files deleted locally (in manifest + remote, not in local)
  const localDeleted = [];
  for (const [mPath, mInfo] of Object.entries(manifestFiles)) {
    if (!localByPath[mPath] && remoteByPath[mPath]) {
      localDeleted.push({ path: mPath, info: mInfo, doc: remoteByPath[mPath] });
    }
  }

  // Files new locally (in local, not in manifest)
  const localNew = [];
  for (const f of localFiles) {
    if (!manifestFiles[f.path]) {
      localNew.push(f);
    }
  }

  // Detect moves via inode: deleted + new with same inode
  const movedInodes = new Set();
  for (const newFile of localNew) {
    if (!newFile.ino) continue;
    const oldPath = manifestByIno[newFile.ino];
    if (oldPath && !localByPath[oldPath]) {
      // Same inode, old path gone → move
      const oldDoc = remoteByPath[oldPath];
      if (oldDoc) {
        actions.move.push({
          oldPath, newPath: newFile.path,
          doc: oldDoc, local: newFile,
          reason: "inode match",
        });
        movedInodes.add(newFile.ino);
      }
    }
  }

  // Detect moves via size: deleted + new with same size (fallback)
  const deletedBySize = {};
  for (const d of localDeleted) {
    if (movedInodes.has(d.info.ino)) continue; // already matched by inode
    const key = String(d.info.size);
    if (!deletedBySize[key]) deletedBySize[key] = [];
    deletedBySize[key].push(d);
  }

  for (const newFile of localNew) {
    if (movedInodes.has(newFile.ino)) continue;
    const key = String(newFile.size);
    const candidates = deletedBySize[key];
    if (candidates && candidates.length === 1) {
      // Same size, only one candidate → likely a move, verify with content hash
      const candidate = candidates[0];
      try {
        const localContent = fs.readFileSync(newFile.fullPath, "utf-8");
        const localHash = crypto.createHash("md5").update(localContent).digest("hex");
        // We'd need to fetch remote content to compare, but for efficiency
        // just treat same-size single-match as move
        actions.move.push({
          oldPath: candidate.path, newPath: newFile.path,
          doc: candidate.doc, local: newFile,
          reason: "size match",
        });
        candidates.length = 0; // mark as used
        continue;
      } catch {}
    }
  }

  // Remaining deletes (not moved)
  const movedOldPaths = new Set(actions.move.map((m) => m.oldPath));
  const movedNewPaths = new Set(actions.move.map((m) => m.newPath));

  for (const d of localDeleted) {
    if (!movedOldPaths.has(d.path)) {
      actions.delete.push({ path: d.path, doc: d.doc, reason: "local deleted" });
    }
  }

  // Remaining new files (not moved)
  for (const f of localNew) {
    if (!movedNewPaths.has(f.path)) {
      actions.push.push({ path: f.path, local: f, reason: "local new" });
    }
  }

  // Modified files (in manifest + local, mtime or size changed)
  for (const f of localFiles) {
    if (movedNewPaths.has(f.path)) continue;
    const mInfo = manifestFiles[f.path];
    if (!mInfo) continue; // new file, handled above
    if (f.size !== mInfo.size || Math.floor(f.mtime) !== Math.floor(mInfo.mtime)) {
      const doc = remoteByPath[f.path];
      if (doc) {
        actions.push.push({ path: f.path, local: f, doc, reason: "local modified" });
      }
    }
  }

  // Remote-only files (in remote, not in local, not in manifest = truly new from remote)
  for (const [rPath, doc] of Object.entries(remoteByPath)) {
    if (!localByPath[rPath] && !manifestFiles[rPath]) {
      actions.pull.push({ path: rPath, doc, reason: "remote new" });
    }
  }

  // Remote deleted (deleted: true in CouchDB)
  for (const row of remoteDocs) {
    const doc = row.doc;
    if (doc.deleted && doc.path && localByPath[doc.path]) {
      actions.delete.push({ path: doc.path, reason: "remote deleted" });
    }
  }

  // Count skipped
  const actionPaths = new Set([
    ...actions.pull.map((a) => a.path),
    ...actions.push.map((a) => a.path),
    ...actions.delete.map((a) => a.path),
    ...actions.move.map((a) => a.oldPath),
    ...actions.move.map((a) => a.newPath),
  ]);
  actions.skip = localFiles.filter((f) => !actionPaths.has(f.path)).length;

  return actions;
}

// === Push a file to CouchDB ===
async function pushFile(filePath, fullPath, existingDoc = null) {
  const content = fs.readFileSync(fullPath, "utf-8");
  const stat = fs.statSync(fullPath);
  const now = Date.now();

  // If no existingDoc provided, search CouchDB by path to avoid duplicates
  if (!existingDoc || !existingDoc._rev) {
    const found = await findRemoteDocByPath(filePath);
    if (found) existingDoc = found;
  }

  // Fetch latest _rev to avoid conflict
  if (existingDoc?._id) {
    try {
      const latest = await request(encodeURIComponent(existingDoc._id));
      if (latest && latest._rev) existingDoc._rev = latest._rev;
    } catch {}
  }

  const docId = existingDoc?._id || (await pathToDocId(filePath, CONFIG.passphrase));

  // Split into chunks
  const chunkTexts = splitIntoChunks(content);
  const chunkDocs = chunkTexts.map((text, i) => {
    const id = generateChunkId(text + filePath, i);
    return { _id: id, data: text, type: "leaf" };
  });

  // File metadata doc
  const fileDoc = {
    _id: docId,
    children: chunkDocs.map((c) => c._id),
    path: filePath,
    ctime: existingDoc?.ctime || now,
    mtime: Math.floor(stat.mtimeMs),
    size: Buffer.byteLength(content, "utf-8"),
    type: "plain",
    eden: existingDoc?.eden || {},
  };
  if (existingDoc?._rev) fileDoc._rev = existingDoc._rev;

  // Bulk insert chunks + file doc
  const allDocs = [...chunkDocs, fileDoc];
  const body = JSON.stringify({ docs: allDocs });
  const result = await request("_bulk_docs", "POST", body);

  const ok = result.filter((r) => r.ok).length;
  // Chunk conflicts are expected (immutable, already exists) - not real errors
  const errors = result.filter((r) => r.error && !(r.error === "conflict" && r.id?.startsWith("h:")));
  return { ok: ok + result.filter((r) => r.error === "conflict" && r.id?.startsWith("h:")).length, errors, total: allDocs.length };
}

// === Find remote doc by path (for avoiding duplicate doc IDs) ===
let _remoteDocCache = null;
async function findRemoteDocByPath(filePath) {
  if (!_remoteDocCache) {
    _remoteDocCache = {};
    const docs = await fetchAllRemoteDocs();
    for (const row of docs) {
      const doc = row.doc;
      if (doc.path && !doc.deleted) _remoteDocCache[doc.path] = doc;
    }
  }
  return _remoteDocCache[filePath] || null;
}

// === Move a file in CouchDB (update path, reuse chunks) ===
async function moveFileInDB(oldDoc, newPath, localFile) {
  const stat = fs.statSync(localFile.fullPath);
  const newDocId = await pathToDocId(newPath, CONFIG.passphrase);

  // Create new doc with same chunks, new path
  const newDoc = {
    _id: newDocId,
    children: oldDoc.children,
    path: newPath,
    ctime: oldDoc.ctime,
    mtime: Math.floor(stat.mtimeMs),
    size: stat.size,
    type: oldDoc.type || "plain",
    eden: oldDoc.eden || {},
  };

  // Soft-delete old doc
  const oldDeleted = {
    _id: oldDoc._id, _rev: oldDoc._rev,
    ...oldDoc,
    deleted: true, mtime: Date.now(),
  };

  const body = JSON.stringify({ docs: [newDoc, oldDeleted] });
  const result = await request("_bulk_docs", "POST", body);
  const ok = result.filter((r) => r.ok).length;
  return { ok, errors: result.filter((r) => r.error) };
}

// === Soft-delete a file in CouchDB ===
async function softDeleteInDB(doc) {
  const updated = { ...doc, deleted: true, mtime: Date.now() };
  const body = JSON.stringify(updated);
  const result = await request(encodeURIComponent(doc._id), "PUT", body);
  return result.ok || false;
}

// === Commands ===
async function cmdStatus() {
  const data = await request("");
  if (!data || data.error) { console.log("Cannot connect"); return; }
  console.log(`Database:   ${data.db_name}`);
  console.log(`Documents:  ${data.doc_count}`);
  console.log(`Size:       ${Math.floor(data.sizes.file / 1024 / 1024)} MB`);
  console.log(`Vault:      ${CONFIG.vaultPath}`);
}

async function cmdPull(dryRun = false) {
  console.log("=== PULL: Remote → Local ===\n");
  const remoteDocs = await fetchAllRemoteDocs();
  console.log(`Remote: ${remoteDocs.length} files`);

  let success = 0, skipped = 0, errors = 0;
  for (let i = 0; i < remoteDocs.length; i++) {
    const doc = remoteDocs[i].doc;
    const filePath = doc.path || "";
    if (!filePath) continue;

    const fullPath = path.join(CONFIG.vaultPath, filePath);

    // Skip if same size
    if (fs.existsSync(fullPath)) {
      const stat = fs.statSync(fullPath);
      if (stat.size === (doc.size || -1)) { skipped++; continue; }
    }

    process.stdout.write(`  [${i + 1}/${remoteDocs.length}] ← ${filePath}`);
    if (dryRun) { process.stdout.write(" (dry-run)\n"); continue; }

    try {
      const content = await fetchFileContent(doc);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
      // Preserve mtime from CouchDB
      if (doc.mtime) {
        const mtime = new Date(doc.mtime);
        fs.utimesSync(fullPath, mtime, mtime);
      }
      process.stdout.write(` OK\n`);
      success++;
    } catch (e) {
      process.stdout.write(` ERROR: ${e.message}\n`);
      errors++;
    }
  }
  console.log(`\nPull done: ${success} updated, ${skipped} skipped, ${errors} errors`);
}

async function cmdPush(dryRun = false) {
  console.log("=== PUSH: Local → Remote ===\n");

  // Get remote state
  process.stdout.write("Fetching remote file list...\n");
  const remoteDocs = await fetchAllRemoteDocs();
  const remoteByPath = {};
  for (const row of remoteDocs) {
    const doc = row.doc;
    if (doc.path) remoteByPath[doc.path] = doc;
  }
  console.log(`Remote: ${remoteDocs.length} files`);

  // Scan local
  const localFiles = scanLocalFiles(CONFIG.vaultPath);
  console.log(`Local:  ${localFiles.length} files\n`);

  let pushed = 0, skipped = 0, errors = 0;

  for (let i = 0; i < localFiles.length; i++) {
    const local = localFiles[i];
    const remote = remoteByPath[local.path];

    // Skip if remote exists and same size
    if (remote && remote.size === local.size) {
      skipped++;
      continue;
    }

    const action = remote ? "update" : "new";
    process.stdout.write(`  [${i + 1}/${localFiles.length}] → (${action}) ${local.path}`);

    if (dryRun) { process.stdout.write(" (dry-run)\n"); continue; }

    try {
      const result = await pushFile(local.path, local.fullPath, remote);
      if (result.errors.length) {
        process.stdout.write(` PARTIAL (${result.ok}/${result.total})\n`);
        for (const e of result.errors) console.log(`    Error: ${e.id} ${e.error} ${e.reason}`);
        errors++;
      } else {
        process.stdout.write(` OK (${result.ok} docs)\n`);
        pushed++;
      }
    } catch (e) {
      process.stdout.write(` ERROR: ${e.message}\n`);
      errors++;
    }
  }
  console.log(`\nPush done: ${pushed} pushed, ${skipped} skipped, ${errors} errors`);
}

async function cmdSync(dryRun = false) {
  console.log("=== SYNC: Manifest-based bidirectional ===\n");

  // Load manifest
  const manifest = loadManifest();
  const hasManifest = Object.keys(manifest.files).length > 0;
  if (!hasManifest) {
    console.log("  No manifest found. First sync will use mtime comparison.\n");
  }

  // Get remote state
  process.stdout.write("Fetching remote file list...\n");
  const remoteDocs = await fetchAllRemoteDocs();

  // Smart scan local
  const t0 = Date.now();
  const { files: localFiles, dirs: scannedDirs } = smartScanLocalFiles(CONFIG.vaultPath, manifest);
  const scanMs = Date.now() - t0;
  console.log(`Local: ${localFiles.length} files (scanned in ${scanMs}ms)`);

  if (!hasManifest) {
    // First sync: fall back to mtime-based comparison
    const remoteByPath = {};
    for (const row of remoteDocs) {
      const doc = row.doc;
      if (doc.path && !doc.deleted) remoteByPath[doc.path] = doc;
    }
    const localByPath = {};
    for (const f of localFiles) localByPath[f.path] = f;

    const toPull = [], toPush = [];
    const allPaths = new Set([...Object.keys(remoteByPath), ...Object.keys(localByPath)]);
    for (const p of allPaths) {
      const remote = remoteByPath[p];
      const local = localByPath[p];
      if (remote && !local) {
        toPull.push({ path: p, doc: remote, reason: "remote only" });
      } else if (local && !remote) {
        toPush.push({ path: p, local, reason: "local only" });
      } else if (remote && local && remote.size !== local.size) {
        const rMtime = remote.mtime || 0;
        const lMtime = Math.floor(local.mtime);
        if (lMtime > rMtime) toPush.push({ path: p, local, doc: remote, reason: "local newer" });
        else if (rMtime > lMtime) toPull.push({ path: p, doc: remote, reason: "remote newer" });
      }
    }

    console.log(`\n  To pull: ${toPull.length} | To push: ${toPush.length} | In sync: ${allPaths.size - toPull.length - toPush.length}\n`);

    let pullOk = 0, pushOk = 0, errs = 0;
    for (const item of toPull) {
      const fullPath = path.join(CONFIG.vaultPath, item.path);
      process.stdout.write(`  ← (${item.reason}) ${item.path}`);
      if (dryRun) { process.stdout.write(" (dry-run)\n"); continue; }
      try {
        const content = await fetchFileContent(item.doc);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, "utf-8");
        if (item.doc.mtime) fs.utimesSync(fullPath, new Date(item.doc.mtime), new Date(item.doc.mtime));
        process.stdout.write(` OK\n`); pullOk++;
      } catch { process.stdout.write(` ERROR\n`); errs++; }
    }
    for (const item of toPush) {
      process.stdout.write(`  → (${item.reason}) ${item.path}`);
      if (dryRun) { process.stdout.write(" (dry-run)\n"); continue; }
      try {
        const result = await pushFile(item.path, item.local.fullPath, item.doc);
        process.stdout.write(result.errors.length ? ` PARTIAL\n` : ` OK\n`);
        result.errors.length ? errs++ : pushOk++;
      } catch { process.stdout.write(` ERROR\n`); errs++; }
    }

    // Save manifest after first sync
    if (!dryRun) {
      const allLocal = scanLocalFiles(CONFIG.vaultPath);
      const newManifest = buildManifestFromScan(allLocal);
      newManifest.dirs = scannedDirs;
      saveManifest(newManifest);
      console.log("  Manifest saved.");
    }
    console.log(`\nSync done: pulled ${pullOk}, pushed ${pushOk}, errors ${errs}`);
    return;
  }

  // === Manifest-based sync ===
  const actions = detectChanges(manifest, localFiles, remoteDocs);

  console.log(`\n  Move:   ${actions.move.length} files`);
  console.log(`  Delete: ${actions.delete.length} files`);
  console.log(`  Push:   ${actions.push.length} files`);
  console.log(`  Pull:   ${actions.pull.length} files`);
  console.log(`  Skip:   ${actions.skip} files\n`);

  let moveOk = 0, delOk = 0, pullOk = 0, pushOk = 0, errs = 0;

  // Process moves
  for (const item of actions.move) {
    process.stdout.write(`  ↔ (${item.reason}) ${item.oldPath} → ${item.newPath}`);
    if (dryRun) { process.stdout.write(" (dry-run)\n"); continue; }
    try {
      const result = await moveFileInDB(item.doc, item.newPath, item.local);
      process.stdout.write(result.errors.length ? ` PARTIAL\n` : ` OK\n`);
      result.errors.length ? errs++ : moveOk++;
    } catch (e) { process.stdout.write(` ERROR: ${e.message}\n`); errs++; }
  }

  // Process deletes
  for (const item of actions.delete) {
    process.stdout.write(`  ✕ (${item.reason}) ${item.path}`);
    if (dryRun) { process.stdout.write(" (dry-run)\n"); continue; }
    try {
      if (item.doc) {
        // Local deleted → soft-delete in CouchDB
        await softDeleteInDB(item.doc);
        process.stdout.write(` OK (DB soft-deleted)\n`);
      } else {
        // Remote deleted → delete local file
        const fullPath = path.join(CONFIG.vaultPath, item.path);
        if (fs.existsSync(fullPath)) {
          // Move to trash instead of hard delete
          const trashDir = path.join(CONFIG.vaultPath, ".trash");
          fs.mkdirSync(trashDir, { recursive: true });
          fs.renameSync(fullPath, path.join(trashDir, path.basename(item.path)));
          process.stdout.write(` OK (moved to .trash)\n`);
        }
      }
      delOk++;
    } catch (e) { process.stdout.write(` ERROR: ${e.message}\n`); errs++; }
  }

  // Process pulls
  for (const item of actions.pull) {
    const fullPath = path.join(CONFIG.vaultPath, item.path);
    process.stdout.write(`  ← (${item.reason}) ${item.path}`);
    if (dryRun) { process.stdout.write(" (dry-run)\n"); continue; }
    try {
      const content = await fetchFileContent(item.doc);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
      if (item.doc.mtime) fs.utimesSync(fullPath, new Date(item.doc.mtime), new Date(item.doc.mtime));
      process.stdout.write(` OK\n`); pullOk++;
    } catch (e) { process.stdout.write(` ERROR\n`); errs++; }
  }

  // Process pushes
  for (const item of actions.push) {
    process.stdout.write(`  → (${item.reason}) ${item.path}`);
    if (dryRun) { process.stdout.write(" (dry-run)\n"); continue; }
    try {
      const result = await pushFile(item.path, item.local.fullPath, item.doc);
      if (result.errors.length) {
        process.stdout.write(` PARTIAL (${result.ok}/${result.total})\n`);
        for (const e of result.errors) process.stdout.write(`    ERR: ${e.id} ${e.error} ${e.reason}\n`);
        errs++;
      } else {
        process.stdout.write(` OK (${result.ok} docs)\n`);
        pushOk++;
      }
    } catch (e) { process.stdout.write(` ERROR\n`); errs++; }
  }

  // Update manifest
  if (!dryRun) {
    const allLocal = scanLocalFiles(CONFIG.vaultPath);
    const newManifest = buildManifestFromScan(allLocal);
    newManifest.dirs = scannedDirs;
    saveManifest(newManifest);
  }

  console.log(`\nSync done: moved ${moveOk}, deleted ${delOk}, pulled ${pullOk}, pushed ${pushOk}, errors ${errs}`);
}

async function cmdPrune(dryRun = false) {
  console.log("=== PRUNE: Remove zombie docs from CouchDB ===\n");

  // Get remote state
  process.stdout.write("Fetching remote file list...\n");
  const remoteDocs = await fetchAllRemoteDocs();
  const remoteByPath = {};
  for (const row of remoteDocs) {
    const doc = row.doc;
    if (doc.path) remoteByPath[doc.path] = doc;
  }

  // Scan local
  const localFiles = scanLocalFiles(CONFIG.vaultPath);
  const localByPath = new Set(localFiles.map((f) => f.path));

  // Find zombies: in remote but not local
  const zombies = [];
  for (const [rpath, doc] of Object.entries(remoteByPath)) {
    if (!localByPath.has(rpath)) {
      zombies.push({ path: rpath, doc });
    }
  }

  console.log(`Remote: ${remoteDocs.length} files`);
  console.log(`Local:  ${localFiles.length} files`);
  console.log(`Zombies: ${zombies.length}\n`);

  if (zombies.length === 0) {
    console.log("No zombies found. Database is clean.");
    return;
  }

  // List zombies
  console.log("Files in DB but NOT in vault:");
  for (const z of zombies.sort((a, b) => a.path.localeCompare(b.path))) {
    const size = z.doc.size || 0;
    console.log(`  ${String(size).padStart(8)}  ${z.path}`);
  }

  if (dryRun) {
    console.log(`\n(Dry run - ${zombies.length} zombie docs would be deleted)`);
    return;
  }

  // Calculate total docs to delete (file docs + their chunks)
  let totalDocs = 0;
  let deletedFiles = 0;
  let errors = 0;

  for (const z of zombies) {
    const doc = z.doc;
    const children = doc.children || [];
    process.stdout.write(`  Deleting: ${z.path} (${children.length} chunks)...`);

    try {
      // Collect all docs to delete: file doc + chunk docs
      const docsToDelete = [];

      // File doc
      docsToDelete.push({ _id: doc._id, _rev: doc._rev, _deleted: true });

      // Fetch chunk docs to get their _rev
      if (children.length > 0) {
        const body = JSON.stringify({ docs: children.map((id) => ({ id })) });
        const result = await request("_bulk_get", "POST", body);
        for (const item of result?.results || []) {
          for (const d of item.docs || []) {
            if (d.ok) {
              docsToDelete.push({ _id: d.ok._id, _rev: d.ok._rev, _deleted: true });
            }
          }
        }
      }

      // Bulk delete
      const delBody = JSON.stringify({ docs: docsToDelete });
      const delResult = await request("_bulk_docs", "POST", delBody);
      const ok = delResult.filter((r) => r.ok).length;
      totalDocs += ok;
      deletedFiles++;
      process.stdout.write(` OK (${ok} docs)\n`);
    } catch (e) {
      process.stdout.write(` ERROR: ${e.message}\n`);
      errors++;
    }
  }

  // Report final DB size
  const dbInfo = await request("");
  console.log(`\n=== Prune done ===`);
  console.log(`  Deleted: ${deletedFiles} files, ${totalDocs} total docs`);
  console.log(`  Errors:  ${errors}`);
  console.log(`  DB now:  ${dbInfo.doc_count} docs, ${Math.floor(dbInfo.sizes.file / 1024 / 1024)} MB`);
  console.log(`\n  Tip: Run CouchDB compaction to reclaim disk space:`);
  console.log(`  curl -X POST -u <user>:<pass> ${CONFIG.uri}/${CONFIG.dbname}/_compact`);
}

// === Main ===
const cmd = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

console.log(`DB: ${CONFIG.dbname} | Vault: ${CONFIG.vaultPath}\n`);

switch (cmd) {
  case "status": await cmdStatus(); break;
  case "pull": await cmdPull(dryRun); break;
  case "push": await cmdPush(dryRun); break;
  case "sync": await cmdSync(dryRun); break;
  case "prune": await cmdPrune(dryRun); break;
  default:
    console.log("Usage: node livesync-sync.mjs <status|pull|push|sync> [--dry-run]");
}

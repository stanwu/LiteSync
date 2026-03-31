#!/usr/bin/env node
/**
 * LiveSync CLI - Fetch Obsidian vault from CouchDB (Self-hosted LiveSync)
 *
 * Usage:
 *   node livesync-cli.mjs status          # Show database info
 *   node livesync-cli.mjs list            # List all files
 *   node livesync-cli.mjs fetch           # Download vault from CouchDB
 *   node livesync-cli.mjs fetch --dry-run # Preview only
 */

import https from "https";
import fs from "fs";
import path from "path";

// === Configuration ===
const CONFIG = {
  uri: "https://your-server/couchdb",
  user: process.env.LIVESYNC_USER || "admin",
  password: "your-password",
  dbname: "obsidianlivesync",
  vaultPath: process.env.VAULT_PATH || `${process.env.HOME}/Obsidian_Vault/個人筆記庫`,
  batchSize: 200,
};

const AUTH = Buffer.from(`${CONFIG.user}:${CONFIG.password}`).toString("base64");

// === HTTP Helper ===
function request(urlPath, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.uri}/${CONFIG.dbname}/${urlPath}`);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Basic ${AUTH}`,
        "Content-Type": "application/json",
      },
      rejectUnauthorized: false,
    };
    if (body) options.headers["Content-Length"] = Buffer.byteLength(body);

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const data = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Parse error: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// === Fetch all file docs ===
async function fetchAllFileDocs() {
  process.stdout.write("Fetching file list from CouchDB...\n");
  const allDocs = [];
  let skip = 0;
  const startkey = encodeURIComponent('"f:"');
  const endkey = encodeURIComponent('"f:\ufff0"');

  while (true) {
    const urlPath = `_all_docs?include_docs=true&startkey=${startkey}&endkey=${endkey}&limit=${CONFIG.batchSize}&skip=${skip}`;
    const data = await request(urlPath);
    if (!data || !data.rows || data.rows.length === 0) break;
    allDocs.push(...data.rows);
    skip += data.rows.length;
    process.stdout.write(`  Fetched ${allDocs.length} file entries...\n`);
    if (data.rows.length < CONFIG.batchSize) break;
  }
  return allDocs;
}

// === Fetch chunks via _bulk_get ===
async function fetchChunks(chunkIds) {
  const body = JSON.stringify({ docs: chunkIds.map((id) => ({ id })) });
  const result = await request("_bulk_get", "POST", body);
  const chunkMap = {};
  if (result && result.results) {
    for (const item of result.results) {
      for (const docItem of item.docs || []) {
        if (docItem.ok) {
          chunkMap[docItem.ok._id] = docItem.ok.data || "";
        }
      }
    }
  }
  return chunkMap;
}

// === Reconstruct file content ===
async function fetchFileContent(doc) {
  const children = doc.children || [];
  if (children.length === 0) return "";
  const chunkMap = await fetchChunks(children);
  return children.map((id) => chunkMap[id] || "").join("");
}

// === Commands ===
async function cmdStatus() {
  const data = await request("");
  if (!data || data.error) {
    console.log("Cannot connect to CouchDB");
    return;
  }
  console.log(`Database:   ${data.db_name}`);
  console.log(`Documents:  ${data.doc_count}`);
  console.log(`Deleted:    ${data.doc_del_count}`);
  console.log(`Size:       ${Math.floor(data.sizes.file / 1024 / 1024)} MB`);
}

async function cmdList() {
  const docs = await fetchAllFileDocs();
  const files = docs
    .map((r) => ({ path: r.doc.path || "", size: r.doc.size || 0 }))
    .sort((a, b) => a.path.localeCompare(b.path));

  console.log(`\nTotal: ${files.length} files\n`);
  for (const f of files) {
    const sizeStr = String(f.size).padStart(8);
    console.log(`  ${sizeStr}  ${f.path}`);
  }
}

async function cmdFetch(dryRun = false) {
  const docs = await fetchAllFileDocs();
  console.log(`\nFound ${docs.length} files in remote database.`);
  if (dryRun) console.log("(Dry run - no files will be written)");

  const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp3", ".mp4", ".zip", ".bmp", ".svg", ".ico"]);

  let success = 0, errors = 0, skipped = 0;

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i].doc;
    const filePath = doc.path || "";
    if (!filePath) continue;

    const fullPath = path.join(CONFIG.vaultPath, filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isBinary = BINARY_EXT.has(ext);

    // Skip if local file exists and same size
    if (fs.existsSync(fullPath)) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size === (doc.size || -1)) {
          skipped++;
          continue;
        }
      } catch {}
    }

    const progress = `[${i + 1}/${docs.length}]`;
    process.stdout.write(`  ${progress} ${isBinary ? "(bin) " : ""}${filePath}`);

    if (dryRun) {
      process.stdout.write(" (skip)\n");
      continue;
    }

    try {
      const content = await fetchFileContent(doc);
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });

      if (isBinary && content) {
        // Binary: try base64 decode
        let rawData;
        if (content.startsWith("data:")) {
          const commaIdx = content.indexOf(",");
          rawData = Buffer.from(content.slice(commaIdx + 1), "base64");
        } else {
          try {
            rawData = Buffer.from(content, "base64");
          } catch {
            rawData = Buffer.from(content, "utf-8");
          }
        }
        fs.writeFileSync(fullPath, rawData);
      } else {
        fs.writeFileSync(fullPath, content, "utf-8");
      }
      // Preserve mtime from CouchDB
      if (doc.mtime) {
        const mtime = new Date(doc.mtime);
        fs.utimesSync(fullPath, mtime, mtime);
      }
      process.stdout.write(` OK (${content.length} bytes)\n`);
      success++;
    } catch (e) {
      process.stdout.write(` ERROR: ${e.message}\n`);
      errors++;
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  Success: ${success}`);
  console.log(`  Skipped: ${skipped} (same size)`);
  console.log(`  Errors:  ${errors}`);
}

// === Main ===
const cmd = process.argv[2];
const dryRun = process.argv.includes("--dry-run");

switch (cmd) {
  case "status": await cmdStatus(); break;
  case "list": await cmdList(); break;
  case "fetch": await cmdFetch(dryRun); break;
  default:
    console.log("Usage: node livesync-cli.mjs <status|list|fetch> [--dry-run]");
}

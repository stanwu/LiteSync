#!/usr/bin/env node
/**
 * LiveSync Sync CLI - Comprehensive Test Suite
 * Runs on sandbox DB: livesync_sandbox_test
 */

import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";

// === Test sandbox config ===
const TEST_DB = "livesync_sandbox_test";
const TEST_VAULT = "/tmp/livesync-test-suite";
const CONFIG = {
  uri: "https://your-server/couchdb",
  user: "admin",
  password: "your-password",
};
const AUTH = Buffer.from(`${CONFIG.user}:${CONFIG.password}`).toString("base64");

// === Test framework ===
let passed = 0, failed = 0, total = 0;
const failures = [];

function assert(condition, msg) {
  total++;
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    failed++;
    failures.push(msg);
    process.stdout.write(`  ✗ ${msg}\n`);
  }
}

function assertEqual(actual, expected, msg) {
  total++;
  if (actual === expected) {
    passed++;
    process.stdout.write(`  ✓ ${msg}\n`);
  } else {
    failed++;
    failures.push(`${msg} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`);
    process.stdout.write(`  ✗ ${msg} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})\n`);
  }
}

function assertIncludes(str, substr, msg) {
  assert(str.includes(substr), msg);
}

// === HTTP helpers ===
function rawRequest(dbPath, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.uri}/${dbPath}`);
    const mod = url.protocol === "https:" ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method,
      headers: { Authorization: `Basic ${AUTH}`, "Content-Type": "application/json" },
      rejectUnauthorized: false,
    };
    if (body) options.headers["Content-Length"] = Buffer.byteLength(body);
    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// === Setup / Teardown ===
async function setupTestDB() {
  // Delete if exists
  await rawRequest(TEST_DB, "DELETE");
  // Create fresh
  const res = await rawRequest(TEST_DB, "PUT");
  return res.status === 201 || res.body?.ok;
}

async function teardownTestDB() {
  await rawRequest(TEST_DB, "DELETE");
}

function setupTestVault() {
  if (fs.existsSync(TEST_VAULT)) fs.rmSync(TEST_VAULT, { recursive: true });
  fs.mkdirSync(TEST_VAULT, { recursive: true });
}

function runCLI(args) {
  const env = {
    ...process.env,
    LIVESYNC_DB: TEST_DB,
    VAULT_PATH: TEST_VAULT,
  };
  try {
    return execSync(`node ${path.resolve("livesync-sync.mjs")} ${args}`, {
      encoding: "utf-8",
      env,
      timeout: 60000,
    });
  } catch (e) {
    return e.stdout || e.message;
  }
}

// === Insert test data directly into CouchDB ===
async function insertRemoteFile(filePath, content, mtime = Date.now()) {
  const chunks = [];
  // Split by character count (not bytes) to avoid mid-char splits
  let pos = 0;
  const maxChars = 150;
  while (pos < content.length) {
    const end = Math.min(pos + maxChars, content.length);
    chunks.push(content.slice(pos, end));
    pos = end;
  }
  if (chunks.length === 0) chunks.push("");

  const chunkDocs = chunks.map((text, i) => {
    const id = "h:test_" + crypto.createHash("md5").update(filePath + i).digest("hex").slice(0, 12);
    return { _id: id, data: text, type: "leaf" };
  });

  const fileDoc = {
    _id: "f:test_" + crypto.createHash("md5").update(filePath).digest("hex"),
    children: chunkDocs.map((c) => c._id),
    path: filePath,
    ctime: mtime,
    mtime: mtime,
    size: Buffer.byteLength(content, "utf-8"),
    type: "plain",
    eden: {},
  };

  const allDocs = [...chunkDocs, fileDoc];
  const res = await rawRequest(`${TEST_DB}/_bulk_docs`, "POST", JSON.stringify({ docs: allDocs }));
  return res.body.every((r) => r.ok);
}

async function getRemoteFile(filePath) {
  const id = "f:test_" + crypto.createHash("md5").update(filePath).digest("hex");
  const res = await rawRequest(`${TEST_DB}/${encodeURIComponent(id)}`);
  return res.status === 200 ? res.body : null;
}

async function getRemoteFileCount() {
  const res = await rawRequest(`${TEST_DB}/_all_docs?startkey=${encodeURIComponent('"f:"')}&endkey=${encodeURIComponent('"f:\ufff0"')}`);
  return res.body?.rows?.length || 0;
}

// ================================================================
// TEST SUITES
// ================================================================

async function testStatus() {
  console.log("\n--- Test: status ---");
  const output = runCLI("status");
  assertIncludes(output, TEST_DB, "status shows database name");
  assertIncludes(output, "Documents:", "status shows document count");
  assertIncludes(output, "Size:", "status shows size");
  assertIncludes(output, TEST_VAULT, "status shows vault path");
}

async function testPullEmptyRemote() {
  console.log("\n--- Test: pull from empty remote ---");
  const output = runCLI("pull");
  assertIncludes(output, "Remote: 0 files", "pull detects empty remote");
  assertIncludes(output, "0 updated", "pull reports 0 updated");
}

async function testPullSingleFile() {
  console.log("\n--- Test: pull single text file ---");
  await insertRemoteFile("test/hello.md", "# Hello World\n\nThis is a test.");
  const output = runCLI("pull");
  assertIncludes(output, "1 files", "pull detects 1 remote file");
  assert(fs.existsSync(path.join(TEST_VAULT, "test/hello.md")), "file created locally");
  const content = fs.readFileSync(path.join(TEST_VAULT, "test/hello.md"), "utf-8");
  assertEqual(content, "# Hello World\n\nThis is a test.", "content matches");
}

async function testPullSkipExisting() {
  console.log("\n--- Test: pull skips existing same-size file ---");
  const output = runCLI("pull");
  assertIncludes(output, "1 skipped", "existing file skipped");
  assertIncludes(output, "0 updated", "no files updated");
}

async function testPullMultipleFiles() {
  console.log("\n--- Test: pull multiple files ---");
  await insertRemoteFile("folder-a/note1.md", "Note 1 content");
  await insertRemoteFile("folder-a/note2.md", "Note 2 content here");
  await insertRemoteFile("folder-b/深い/日本語.md", "日本語テスト");
  const output = runCLI("pull");
  assert(fs.existsSync(path.join(TEST_VAULT, "folder-a/note1.md")), "note1 created");
  assert(fs.existsSync(path.join(TEST_VAULT, "folder-a/note2.md")), "note2 created");
  assert(fs.existsSync(path.join(TEST_VAULT, "folder-b/深い/日本語.md")), "Japanese path file created");
  const jpContent = fs.readFileSync(path.join(TEST_VAULT, "folder-b/深い/日本語.md"), "utf-8");
  assertEqual(jpContent, "日本語テスト", "Japanese content matches");
}

async function testPullLargeFile() {
  console.log("\n--- Test: pull large multi-chunk file ---");
  const largeContent = "# Large File\n\n" + "這是一段很長的中文內容。".repeat(100) + "\n\n## End";
  await insertRemoteFile("test/large.md", largeContent);
  runCLI("pull");
  const pulled = fs.readFileSync(path.join(TEST_VAULT, "test/large.md"), "utf-8");
  assertEqual(pulled, largeContent, "large file content matches");
}

async function testPullEmptyFile() {
  console.log("\n--- Test: pull empty file ---");
  await insertRemoteFile("test/empty.md", "");
  runCLI("pull");
  assert(fs.existsSync(path.join(TEST_VAULT, "test/empty.md")), "empty file created");
  const content = fs.readFileSync(path.join(TEST_VAULT, "test/empty.md"), "utf-8");
  assertEqual(content, "", "empty file is empty");
}

async function testPullSpecialCharsInPath() {
  console.log("\n--- Test: pull file with special chars in path ---");
  await insertRemoteFile("00_收件箱/AI 與人類的未來 (2024).md", "Special chars test");
  runCLI("pull");
  assert(
    fs.existsSync(path.join(TEST_VAULT, "00_收件箱/AI 與人類的未來 (2024).md")),
    "file with spaces and parens created"
  );
}

async function testPullDryRun() {
  console.log("\n--- Test: pull --dry-run ---");
  await insertRemoteFile("test/dryrun.md", "Should not appear");
  const output = runCLI("pull --dry-run");
  assertIncludes(output, "dry-run", "dry-run label shown");
  assert(!fs.existsSync(path.join(TEST_VAULT, "test/dryrun.md")), "file NOT created in dry-run");
  // Clean up: pull for real so it doesn't interfere
  runCLI("pull");
}

async function testPushNewFile() {
  console.log("\n--- Test: push new local file ---");
  fs.mkdirSync(path.join(TEST_VAULT, "local-new"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, "local-new/from-local.md"), "# Created Locally\n\nPush test.", "utf-8");
  const output = runCLI("push");
  assertIncludes(output, "(new)", "push detects new file");
  assert(output.includes("pushed") && !output.includes("0 pushed"), "at least 1 file pushed");
  // Verify in CouchDB
  const count = await getRemoteFileCount();
  assert(count >= 8, `remote has ${count} files after push`);
}

async function testPushSkipUnchanged() {
  console.log("\n--- Test: push skips unchanged files ---");
  const output = runCLI("push");
  assertIncludes(output, "0 pushed", "no files pushed when unchanged");
}

async function testPushUpdateFile() {
  console.log("\n--- Test: push updated local file ---");
  // Modify a file that exists in remote
  const fpath = path.join(TEST_VAULT, "test/hello.md");
  fs.writeFileSync(fpath, "# Hello World UPDATED\n\nModified content.", "utf-8");
  const output = runCLI("push");
  assertIncludes(output, "(update)", "push detects update");
  assertIncludes(output, "1 pushed", "1 file pushed");
}

async function testPushRoundTrip() {
  console.log("\n--- Test: push then pull round-trip ---");
  // Write a unique file
  const unique = `# Round Trip ${Date.now()}\n\nContent: ${Math.random()}`;
  fs.mkdirSync(path.join(TEST_VAULT, "roundtrip"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, "roundtrip/rt.md"), unique, "utf-8");
  runCLI("push");

  // Delete local and pull back
  fs.unlinkSync(path.join(TEST_VAULT, "roundtrip/rt.md"));
  assert(!fs.existsSync(path.join(TEST_VAULT, "roundtrip/rt.md")), "local file deleted");
  runCLI("pull");
  assert(fs.existsSync(path.join(TEST_VAULT, "roundtrip/rt.md")), "file restored via pull");
  const pulled = fs.readFileSync(path.join(TEST_VAULT, "roundtrip/rt.md"), "utf-8");
  assertEqual(pulled, unique, "round-trip content matches exactly");
}

async function testPushDryRun() {
  console.log("\n--- Test: push --dry-run ---");
  fs.writeFileSync(path.join(TEST_VAULT, "local-new/dryrun-push.md"), "Should not push", "utf-8");
  const beforeCount = await getRemoteFileCount();
  const output = runCLI("push --dry-run");
  assertIncludes(output, "dry-run", "dry-run label shown");
  const afterCount = await getRemoteFileCount();
  assertEqual(afterCount, beforeCount, "remote count unchanged after dry-run push");
  // Clean up
  fs.unlinkSync(path.join(TEST_VAULT, "local-new/dryrun-push.md"));
}

async function testPushChineseContent() {
  console.log("\n--- Test: push file with Chinese content ---");
  const zhContent = "# 繁體中文測試\n\n這是一段繁體中文的內容，包含標點符號：「」、《》、（）。\n\n## 結論\n\n測試成功。";
  fs.mkdirSync(path.join(TEST_VAULT, "中文測試"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, "中文測試/繁體中文.md"), zhContent, "utf-8");
  runCLI("push");

  // Pull back
  fs.unlinkSync(path.join(TEST_VAULT, "中文測試/繁體中文.md"));
  runCLI("pull");
  const pulled = fs.readFileSync(path.join(TEST_VAULT, "中文測試/繁體中文.md"), "utf-8");
  assertEqual(pulled, zhContent, "Chinese content round-trip matches");
}

async function testSyncBidirectional() {
  console.log("\n--- Test: sync bidirectional ---");
  // Add remote-only file
  await insertRemoteFile("sync-test/remote-side.md", "Remote side content", Date.now());
  // Add local-only file
  fs.mkdirSync(path.join(TEST_VAULT, "sync-test"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, "sync-test/local-side.md"), "Local side content", "utf-8");

  const output = runCLI("sync");
  assertIncludes(output, "remote only", "sync detects remote-only file");
  assertIncludes(output, "local only", "sync detects local-only file");
  assert(fs.existsSync(path.join(TEST_VAULT, "sync-test/remote-side.md")), "remote file pulled");
  const remoteContent = fs.readFileSync(path.join(TEST_VAULT, "sync-test/remote-side.md"), "utf-8");
  assertEqual(remoteContent, "Remote side content", "remote content correct");
  assertIncludes(output, "pulled 1", "1 file pulled");
  assertIncludes(output, "pushed 1", "1 file pushed");
}

async function testSyncNewerWins() {
  console.log("\n--- Test: sync newer wins (local newer) ---");
  // Remote has old version
  const oldTime = Date.now() - 100000;
  await insertRemoteFile("conflict/file.md", "OLD remote version", oldTime);
  // Local has newer version
  fs.mkdirSync(path.join(TEST_VAULT, "conflict"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, "conflict/file.md"), "NEW local version", "utf-8");
  // Touch to make it clearly newer
  const futureTime = new Date(Date.now() + 10000);
  fs.utimesSync(path.join(TEST_VAULT, "conflict/file.md"), futureTime, futureTime);

  const output = runCLI("sync");
  // First sync (no manifest) uses mtime comparison
  assert(output.includes("local newer") || output.includes("local only") || output.includes("Push"), "sync handles local newer file");
}

async function testSyncDryRun() {
  console.log("\n--- Test: sync --dry-run ---");
  await insertRemoteFile("sync-dry/remote.md", "Remote dry test", Date.now());
  const output = runCLI("sync --dry-run");
  assertIncludes(output, "dry-run", "dry-run label shown");
  assert(!fs.existsSync(path.join(TEST_VAULT, "sync-dry/remote.md")), "file NOT created in dry-run");
  // Clean up
  runCLI("sync");
}

async function testPushLargeFile() {
  console.log("\n--- Test: push large file ---");
  const large = "# 大型檔案\n\n" + "重複段落用於測試分塊。\n".repeat(500);
  fs.mkdirSync(path.join(TEST_VAULT, "large-test"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, "large-test/big.md"), large, "utf-8");
  const output = runCLI("push");
  assertIncludes(output, "OK", "large file push OK");

  // Round trip
  fs.unlinkSync(path.join(TEST_VAULT, "large-test/big.md"));
  runCLI("pull");
  const pulled = fs.readFileSync(path.join(TEST_VAULT, "large-test/big.md"), "utf-8");
  assertEqual(pulled, large, "large file round-trip matches");
}

async function testSpecialMarkdownContent() {
  console.log("\n--- Test: push/pull markdown with special content ---");
  const md = `# Special Content

## Code block
\`\`\`javascript
const x = { "key": "value" };
console.log(\`template \${x}\`);
\`\`\`

## Table
| Col A | Col B |
|-------|-------|
| 1     | 2     |

## Links & Images
[link](https://example.com)
![img](./image.png)

## Escaped chars
\\* not bold \\*
\\# not heading

## Emoji
🎉 🚀 ✅

## Math
$E = mc^2$

## Tags
#tag1 #tag2

## Frontmatter style
---
title: test
tags: [a, b]
---
`;
  fs.mkdirSync(path.join(TEST_VAULT, "special"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, "special/markdown.md"), md, "utf-8");
  runCLI("push");

  fs.unlinkSync(path.join(TEST_VAULT, "special/markdown.md"));
  runCLI("pull");
  const pulled = fs.readFileSync(path.join(TEST_VAULT, "special/markdown.md"), "utf-8");
  assertEqual(pulled, md, "special markdown round-trip matches");
}

async function testMultipleSyncsIdempotent() {
  console.log("\n--- Test: multiple syncs are idempotent ---");
  const out1 = runCLI("sync");
  const out2 = runCLI("sync");
  // Second sync should have manifest and show minimal changes
  assert(
    (out2.includes("Skip:") && out2.match(/Skip:\s+\d+/)) ||
    out2.includes("In sync:") ||
    (out2.includes("Pull:   0") && out2.includes("Push:   0")),
    "second sync shows mostly skipped"
  );
  assert(
    out2.includes("pulled 0") || out2.includes("Pull:   0"),
    "nothing to pull on second sync"
  );
  assert(
    out2.includes("pushed 0") || out2.includes("Push:   0"),
    "nothing to push on second sync"
  );
}

async function testPruneDryRun() {
  console.log("\n--- Test: prune --dry-run ---");
  // Insert a zombie (no local file)
  await insertRemoteFile("zombie/should-delete.md", "I am a zombie");
  const beforeCount = await getRemoteFileCount();
  const output = runCLI("prune --dry-run");
  assertIncludes(output, "should-delete.md", "prune lists zombie file");
  assert(output.includes("dry-run") || output.includes("would be deleted"), "dry-run mode indicated");
  const afterCount = await getRemoteFileCount();
  assertEqual(afterCount, beforeCount, "remote count unchanged after dry-run prune");
}

async function testPruneRemovesZombies() {
  console.log("\n--- Test: prune removes zombie files ---");
  const beforeCount = await getRemoteFileCount();
  const output = runCLI("prune");
  assertIncludes(output, "should-delete.md", "prune targets zombie");
  assertIncludes(output, "Deleted:", "prune reports deletion");
  assert(!output.includes("Errors:  1"), "no errors during prune");
  // Zombie chunks should also be removed
  const afterCount = await getRemoteFileCount();
  assert(afterCount < beforeCount, `remote count decreased (${beforeCount} → ${afterCount})`);
}

async function testPruneKeepsValidFiles() {
  console.log("\n--- Test: prune keeps valid files ---");
  const output = runCLI("prune");
  assertIncludes(output, "Zombies: 0", "no zombies after cleanup");
  assertIncludes(output, "clean", "reports database is clean");
  // Verify existing synced files still intact
  assert(fs.existsSync(path.join(TEST_VAULT, "test/hello.md")), "valid file still exists locally");
}

async function testDeleteDetection() {
  console.log("\n--- Test: local delete detected via manifest ---");
  // Ensure manifest exists from previous syncs
  // Create a file, sync, then delete it, sync again
  fs.mkdirSync(path.join(TEST_VAULT, "del-test"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, "del-test/will-delete.md"), "Delete me soon", "utf-8");
  runCLI("sync"); // first sync: pushes file, saves manifest

  // Delete locally
  fs.unlinkSync(path.join(TEST_VAULT, "del-test/will-delete.md"));
  const output = runCLI("sync");
  assertIncludes(output, "local deleted", "sync detects local deletion");
  assertIncludes(output, "will-delete.md", "deleted file listed");
  assert(output.includes("Delete:") && !output.includes("Delete: 0"), "delete count > 0");
}

async function testMoveDetectionByInode() {
  console.log("\n--- Test: move detection by inode ---");
  // Create a file, sync, then move it
  fs.mkdirSync(path.join(TEST_VAULT, "move-src"), { recursive: true });
  fs.mkdirSync(path.join(TEST_VAULT, "move-dst"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, "move-src/moveme.md"), "I will be moved", "utf-8");
  runCLI("sync"); // saves manifest with inode

  // Move the file (preserves inode on same filesystem)
  fs.renameSync(
    path.join(TEST_VAULT, "move-src/moveme.md"),
    path.join(TEST_VAULT, "move-dst/moveme.md")
  );
  const output = runCLI("sync --dry-run");
  assert(
    output.includes("inode match") || output.includes("size match") || output.includes("Move:"),
    "sync detects move"
  );
  assertIncludes(output, "moveme.md", "moved file listed");

  // Actually sync
  runCLI("sync");
}

async function testMoveDetectionBySize() {
  console.log("\n--- Test: move detection by size (cross-fs fallback) ---");
  // Create a unique-sized file, sync, delete it, create identical content at new path
  const uniqueContent = `Unique content for size match ${Date.now()} ${"x".repeat(137)}`;
  fs.mkdirSync(path.join(TEST_VAULT, "size-src"), { recursive: true });
  fs.mkdirSync(path.join(TEST_VAULT, "size-dst"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, "size-src/sizefile.md"), uniqueContent, "utf-8");
  runCLI("sync");

  // Simulate cross-fs move (delete + create, different inode)
  fs.unlinkSync(path.join(TEST_VAULT, "size-src/sizefile.md"));
  fs.writeFileSync(path.join(TEST_VAULT, "size-dst/sizefile.md"), uniqueContent, "utf-8");
  const output = runCLI("sync --dry-run");
  // Should detect as move or at minimum handle correctly
  assert(
    output.includes("size match") || output.includes("Move:") ||
    (output.includes("local deleted") && output.includes("local new")),
    "sync handles cross-fs move"
  );
  runCLI("sync");
}

async function testRemoteDeleteDetection() {
  console.log("\n--- Test: remote delete (deleted: true) pulls deletion ---");
  // Create and sync a file
  fs.writeFileSync(path.join(TEST_VAULT, "remote-del.md"), "Will be remotely deleted", "utf-8");
  runCLI("sync");
  assert(fs.existsSync(path.join(TEST_VAULT, "remote-del.md")), "file exists before remote delete");

  // Simulate remote delete by setting deleted: true in CouchDB
  // Find the doc
  const allDocs = await (async () => {
    const res = await rawRequest(`${TEST_DB}/_all_docs?include_docs=true&startkey=${encodeURIComponent('"f:"')}&endkey=${encodeURIComponent('"f:\ufff0"')}`);
    return res.body.rows || [];
  })();
  const targetDoc = allDocs.find(r => r.doc.path === "remote-del.md");
  if (targetDoc) {
    const doc = targetDoc.doc;
    doc.deleted = true;
    doc.mtime = Date.now();
    await rawRequest(`${TEST_DB}/${encodeURIComponent(doc._id)}`, "PUT", JSON.stringify(doc));
  }

  const output = runCLI("sync");
  assertIncludes(output, "remote deleted", "sync detects remote deletion");
  // File should be moved to .trash
  assert(!fs.existsSync(path.join(TEST_VAULT, "remote-del.md")), "file removed after remote delete");
}

async function testSmartScanSpeed() {
  console.log("\n--- Test: smart scan uses directory mtime optimization ---");
  // After syncs, manifest should exist
  const manifest = JSON.parse(fs.readFileSync(path.join(TEST_VAULT, ".livesync-manifest.json"), "utf-8"));
  assert(Object.keys(manifest.files).length > 0, "manifest has files");
  assert(manifest.lastSync > 0, "manifest has lastSync timestamp");

  // Run sync - should be fast since most dirs unchanged
  const t0 = Date.now();
  const output = runCLI("sync");
  const elapsed = Date.now() - t0;
  assert(output.includes("scanned in"), "output shows scan time");
  console.log(`  (sync took ${elapsed}ms)`);
}

async function testHiddenFilesIgnored() {
  console.log("\n--- Test: hidden files/folders ignored ---");
  fs.mkdirSync(path.join(TEST_VAULT, ".obsidian"), { recursive: true });
  fs.writeFileSync(path.join(TEST_VAULT, ".obsidian/config.json"), '{"test":true}', "utf-8");
  fs.writeFileSync(path.join(TEST_VAULT, ".hidden-file.md"), "hidden", "utf-8");
  const output = runCLI("push --dry-run");
  assert(!output.includes(".obsidian"), ".obsidian folder ignored");
  assert(!output.includes(".hidden-file"), "hidden file ignored");
}

async function testStatusAfterOperations() {
  console.log("\n--- Test: status reflects correct state ---");
  const output = runCLI("status");
  assertIncludes(output, "Documents:", "status shows docs");
  // Should have more than initial docs
  const match = output.match(/Documents:\s+(\d+)/);
  const count = match ? parseInt(match[1]) : 0;
  assert(count > 10, `document count ${count} > 10 after operations`);
}

// ================================================================
// Run all tests
// ================================================================
async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  LiveSync Sync CLI - Test Suite          ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`DB: ${TEST_DB}`);
  console.log(`Vault: ${TEST_VAULT}`);

  // Setup
  console.log("\n--- Setup ---");
  const dbOk = await setupTestDB();
  assert(dbOk, "test database created");
  setupTestVault();
  assert(fs.existsSync(TEST_VAULT), "test vault created");

  try {
    // Status
    await testStatus();

    // Pull tests
    await testPullEmptyRemote();
    await testPullSingleFile();
    await testPullSkipExisting();
    await testPullMultipleFiles();
    await testPullLargeFile();
    await testPullEmptyFile();
    await testPullSpecialCharsInPath();
    await testPullDryRun();

    // Push tests
    await testPushNewFile();
    await testPushSkipUnchanged();
    await testPushUpdateFile();
    await testPushRoundTrip();
    await testPushDryRun();
    await testPushChineseContent();
    await testPushLargeFile();
    await testSpecialMarkdownContent();

    // Sync tests
    await testSyncBidirectional();
    await testSyncNewerWins();
    await testSyncDryRun();
    await testMultipleSyncsIdempotent();

    // Prune tests
    await testPruneDryRun();
    await testPruneRemovesZombies();
    await testPruneKeepsValidFiles();

    // Manifest-based tests
    await testDeleteDetection();
    await testMoveDetectionByInode();
    await testMoveDetectionBySize();
    await testRemoteDeleteDetection();
    await testSmartScanSpeed();

    // Edge cases
    await testHiddenFilesIgnored();
    await testStatusAfterOperations();

  } finally {
    // Teardown
    console.log("\n--- Teardown ---");
    await teardownTestDB();
    fs.rmSync(TEST_VAULT, { recursive: true });
    console.log("  Cleaned up test DB and vault");
  }

  // Summary
  console.log("\n╔══════════════════════════════════════════╗");
  console.log(`║  Results: ${passed} passed, ${failed} failed, ${total} total`);
  console.log("╚══════════════════════════════════════════╝");

  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  ✗ ${f}`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

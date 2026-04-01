#!/usr/bin/env node
/**
 * Unit tests for classifyChanges — the core sync decision logic.
 * Run: node test-classify.mjs
 */

// === Extract classifyChanges from main.js (avoid Obsidian runtime) ===
// We re-declare it here since main.js requires('obsidian') which isn't available in Node.

function classifyChanges(manifest, localByPath, remoteByPath, remoteDeleted) {
  var toPull = [];
  var toPush = [];
  var toDeleteRemote = [];
  var toTrashLocal = [];

  var allPaths = {};
  Object.keys(remoteByPath).forEach(function(p) { allPaths[p] = true; });
  Object.keys(manifest).forEach(function(p) { allPaths[p] = true; });
  Object.keys(localByPath).forEach(function(p) { allPaths[p] = true; });

  Object.keys(allPaths).forEach(function(p) {
    var remote = remoteByPath[p];
    var local = localByPath[p];
    var inManifest = !!manifest[p];

    if (inManifest && !local && remote) {
      toDeleteRemote.push({ path: p, doc: remote });
    } else if (inManifest && local && !remote) {
      if (!remoteDeleted[p]) {
        toPush.push({ path: p, file: local, doc: null });
      }
    } else if (!inManifest && !local && remote) {
      toPull.push({ path: p, doc: remote });
    } else if (!inManifest && local && !remote) {
      toPush.push({ path: p, file: local, doc: null });
    } else if (remote && local) {
      if (remote.size === local.stat.size) return;
      var rMtime = remote.mtime || 0;
      var lMtime = local.stat.mtime || 0;
      if (lMtime > rMtime) {
        toPush.push({ path: p, file: local, doc: remote });
      } else if (rMtime > lMtime) {
        toPull.push({ path: p, doc: remote });
      }
    }
  });

  Object.keys(remoteDeleted).forEach(function(p) {
    if (remoteByPath[p]) return;
    if (!manifest[p]) return;
    var local = localByPath[p];
    if (local) {
      toTrashLocal.push({ path: p, file: local });
    }
  });

  return { toPull, toPush, toDeleteRemote, toTrashLocal };
}

// === Test helpers ===
function mkLocal(path, size, mtime) {
  return { path, stat: { size, mtime } };
}
function mkRemote(path, size, mtime) {
  return { _id: "f:" + path, path, size, mtime };
}
function mkDeleted(path) {
  return { _id: "f:del_" + path, path, deleted: true, mtime: Date.now() };
}
function byPath(items) {
  var m = {};
  items.forEach(function(i) { m[i.path || i.stat && i.path] = i; });
  return m;
}
function paths(arr) {
  return arr.map(function(a) { return a.path; }).sort();
}

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  \u2713 " + name);
  } catch (e) {
    failed++;
    failures.push(name + ": " + e.message);
    console.log("  \u2717 " + name + " — " + e.message);
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || "") + " expected " + b + ", got " + a);
}

// ================================================================
// Tests
// ================================================================

console.log("\n--- New local file (not in manifest, not in remote) ---");

test("new local file → push", function() {
  var r = classifyChanges(
    {},
    byPath([mkLocal("new.md", 100, 1000)]),
    {},
    {}
  );
  eq(paths(r.toPush), ["new.md"]);
  eq(r.toPull.length, 0);
  eq(r.toDeleteRemote.length, 0);
  eq(r.toTrashLocal.length, 0);
});

console.log("\n--- New remote file (not in manifest, not in local) ---");

test("new remote file → pull", function() {
  var r = classifyChanges(
    {},
    {},
    byPath([mkRemote("remote.md", 200, 2000)]),
    {}
  );
  eq(paths(r.toPull), ["remote.md"]);
  eq(r.toPush.length, 0);
});

console.log("\n--- Local deletion (in manifest, local gone, remote exists) ---");

test("local deleted → soft-delete remote", function() {
  var r = classifyChanges(
    { "deleted.md": { size: 100, mtime: 1000 } },
    {},
    byPath([mkRemote("deleted.md", 100, 1000)]),
    {}
  );
  eq(paths(r.toDeleteRemote), ["deleted.md"]);
  eq(r.toPull.length, 0);
  eq(r.toPush.length, 0);
  eq(r.toTrashLocal.length, 0);
});

console.log("\n--- Remote deletion (deleted:true flag) ---");

test("remote deleted + in manifest + local exists → trash local", function() {
  var local = mkLocal("gone.md", 100, 1000);
  var r = classifyChanges(
    { "gone.md": { size: 100, mtime: 1000 } },
    byPath([local]),
    {},
    { "gone.md": mkDeleted("gone.md") }
  );
  eq(paths(r.toTrashLocal), ["gone.md"]);
  eq(r.toPush.length, 0);
  eq(r.toPull.length, 0);
});

test("remote deleted + NOT in manifest → do NOT trash (old deletion, first sync)", function() {
  var local = mkLocal("safe.md", 100, 1000);
  var r = classifyChanges(
    {},
    byPath([local]),
    {},
    { "safe.md": mkDeleted("safe.md") }
  );
  eq(r.toTrashLocal.length, 0, "should not trash");
  eq(paths(r.toPush), ["safe.md"], "should push instead");
});

test("remote deleted + active doc also exists → do NOT trash", function() {
  var local = mkLocal("both.md", 100, 1000);
  var activeDoc = mkRemote("both.md", 100, 1000);
  var r = classifyChanges(
    { "both.md": { size: 100, mtime: 1000 } },
    byPath([local]),
    byPath([activeDoc]),
    { "both.md": mkDeleted("both.md") }
  );
  eq(r.toTrashLocal.length, 0, "should not trash when active doc exists");
});

console.log("\n--- Remote doc gone but not deleted flag (purge/compaction) ---");

test("in manifest + local exists + remote gone → re-push (not trash)", function() {
  var local = mkLocal("lost.md", 100, 1000);
  var r = classifyChanges(
    { "lost.md": { size: 100, mtime: 1000 } },
    byPath([local]),
    {},
    {}
  );
  eq(paths(r.toPush), ["lost.md"]);
  eq(r.toTrashLocal.length, 0, "must NOT trash");
  eq(r.toDeleteRemote.length, 0);
});

console.log("\n--- Both exist, size comparison ---");

test("same size → skip (no action)", function() {
  var r = classifyChanges(
    { "same.md": { size: 100, mtime: 1000 } },
    byPath([mkLocal("same.md", 100, 1000)]),
    byPath([mkRemote("same.md", 100, 1000)]),
    {}
  );
  eq(r.toPull.length, 0);
  eq(r.toPush.length, 0);
  eq(r.toDeleteRemote.length, 0);
  eq(r.toTrashLocal.length, 0);
});

test("different size, local newer → push", function() {
  var r = classifyChanges(
    { "mod.md": { size: 100, mtime: 1000 } },
    byPath([mkLocal("mod.md", 200, 2000)]),
    byPath([mkRemote("mod.md", 100, 1000)]),
    {}
  );
  eq(paths(r.toPush), ["mod.md"]);
  eq(r.toPull.length, 0);
});

test("different size, remote newer → pull", function() {
  var r = classifyChanges(
    { "mod.md": { size: 100, mtime: 1000 } },
    byPath([mkLocal("mod.md", 100, 1000)]),
    byPath([mkRemote("mod.md", 200, 2000)]),
    {}
  );
  eq(paths(r.toPull), ["mod.md"]);
  eq(r.toPush.length, 0);
});

console.log("\n--- First sync (empty manifest) ---");

test("empty manifest: local+remote same size → skip", function() {
  var r = classifyChanges(
    {},
    byPath([mkLocal("a.md", 100, 1000)]),
    byPath([mkRemote("a.md", 100, 1000)]),
    {}
  );
  eq(r.toPull.length + r.toPush.length, 0);
});

test("empty manifest: local only → push", function() {
  var r = classifyChanges(
    {},
    byPath([mkLocal("local.md", 100, 1000)]),
    {},
    {}
  );
  eq(paths(r.toPush), ["local.md"]);
});

test("empty manifest: remote only → pull", function() {
  var r = classifyChanges(
    {},
    {},
    byPath([mkRemote("remote.md", 100, 1000)]),
    {}
  );
  eq(paths(r.toPull), ["remote.md"]);
});

test("empty manifest: old deleted docs in DB → ignore all", function() {
  var r = classifyChanges(
    {},
    byPath([mkLocal("a.md", 100, 1000), mkLocal("b.md", 200, 2000)]),
    byPath([mkRemote("a.md", 100, 1000), mkRemote("b.md", 200, 2000)]),
    { "a.md": mkDeleted("a.md"), "c.md": mkDeleted("c.md") }
  );
  eq(r.toTrashLocal.length, 0, "no files trashed on first sync");
});

console.log("\n--- Mixed scenario ---");

test("complex: multiple files, different states", function() {
  var manifest = {
    "synced.md": { size: 100, mtime: 1000 },
    "local-del.md": { size: 50, mtime: 500 },
    "remote-del.md": { size: 75, mtime: 750 },
  };
  var localFiles = [
    mkLocal("synced.md", 100, 1000),
    mkLocal("new-local.md", 30, 3000),
    mkLocal("remote-del.md", 75, 750),
  ];
  var remoteFiles = [
    mkRemote("synced.md", 100, 1000),
    mkRemote("local-del.md", 50, 500),
    mkRemote("new-remote.md", 60, 6000),
  ];
  var r = classifyChanges(
    manifest,
    byPath(localFiles),
    byPath(remoteFiles),
    { "remote-del.md": mkDeleted("remote-del.md") }
  );
  eq(paths(r.toPull), ["new-remote.md"], "pull new remote file");
  eq(paths(r.toPush), ["new-local.md"], "push new local file");
  eq(paths(r.toDeleteRemote), ["local-del.md"], "soft-delete locally removed file");
  eq(paths(r.toTrashLocal), ["remote-del.md"], "trash remotely deleted file");
});

// ================================================================
// Summary
// ================================================================
console.log("\n" + "=".repeat(50));
console.log("Results: " + passed + " passed, " + failed + " failed");
if (failures.length) {
  console.log("\nFailures:");
  for (const f of failures) console.log("  \u2717 " + f);
}
console.log("=".repeat(50));
process.exit(failed > 0 ? 1 : 0);

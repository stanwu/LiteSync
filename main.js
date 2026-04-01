/**
 * LiteSync - Lightweight CouchDB sync plugin for Obsidian
 * Compatible with Self-hosted LiveSync database format.
 * Commands: sync, pull, push, fetch, prune, status
 */

var obsidian = require("obsidian");

// === Default settings ===
var DEFAULT_SETTINGS = {
  couchdbUri: "",
  couchdbUser: "",
  couchdbPassword: "",
  couchdbDbname: "",
  passphrase: "",
  deviceName: "",
  autoSync: false,
  syncInterval: 300,  // seconds, 0 = manual only
};

var BINARY_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf",
  ".mp3", ".mp4", ".zip", ".bmp", ".svg", ".ico", ".wav", ".ogg",
  ".mov", ".avi", ".flac", ".tar", ".gz", ".7z", ".rar"];

function isBinaryFile(filePath) {
  var dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXT.indexOf(filePath.slice(dot).toLowerCase()) !== -1;
}

// === Crypto: SHA-256 via Web Crypto API ===
function sha256Hex(str) {
  var data = new TextEncoder().encode(str);
  return crypto.subtle.digest("SHA-256", data).then(function(buf) {
    var arr = new Uint8Array(buf);
    var hex = "";
    for (var i = 0; i < arr.length; i++) {
      hex += arr[i].toString(16).padStart(2, "0");
    }
    return hex;
  });
}

// Compatible with LiveSync CLI: SHA-256(SHA-256(passphrase) + ":" + path)
function pathToDocId(filePath, passphrase) {
  if (!passphrase) return Promise.resolve("f:" + filePath);
  return sha256Hex(passphrase).then(function(hashedPass) {
    return sha256Hex(hashedPass + ":" + filePath);
  }).then(function(hash) {
    return "f:" + hash;
  });
}

// Compatible with LiveSync CLI: SHA-256(content + index), first 12 hex → BigInt → base36
function generateChunkId(content, index) {
  return sha256Hex(content + String(index)).then(function(hex) {
    var shortHex = hex.slice(0, 12);
    var num = BigInt("0x" + shortHex);
    return "h:" + num.toString(36);
  });
}

// === Binary helpers ===
function base64ToArrayBuffer(base64) {
  var bin = atob(base64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var bin = "";
  var CHUNK = 8192;
  for (var i = 0; i < bytes.length; i += CHUNK) {
    var slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    bin += String.fromCharCode.apply(null, slice);
  }
  return btoa(bin);
}

function decodeBinaryContent(content) {
  if (content.indexOf("data:") === 0) {
    var commaIdx = content.indexOf(",");
    return base64ToArrayBuffer(content.slice(commaIdx + 1));
  }
  return base64ToArrayBuffer(content);
}

// === CouchDB HTTP ===
function couchRequest(settings, urlPath, method, body) {
  var url = settings.couchdbUri + "/" + settings.couchdbDbname + "/" + urlPath;
  var headers = {
    "Content-Type": "application/json",
    "Authorization": "Basic " + btoa(settings.couchdbUser + ":" + settings.couchdbPassword),
  };
  var opts = { url: url, method: method || "GET", headers: headers };
  if (body) opts.body = body;
  return obsidian.requestUrl(opts).then(function(resp) {
    return resp.json;
  });
}

// === Fetch all file docs from CouchDB ===
function fetchAllRemoteDocs(settings) {
  var allDocs = [];
  var batchSize = 200;

  function fetchBatch(skip) {
    var p = "_all_docs?include_docs=true"
      + "&startkey=" + encodeURIComponent('"f:"')
      + "&endkey=" + encodeURIComponent('"f:\ufff0"')
      + "&limit=" + batchSize
      + "&skip=" + skip;
    return couchRequest(settings, p).then(function(data) {
      if (!data || !data.rows || data.rows.length === 0) return allDocs;
      allDocs = allDocs.concat(data.rows);
      if (data.rows.length < batchSize) return allDocs;
      return fetchBatch(skip + data.rows.length);
    });
  }

  return fetchBatch(0);
}

// === Fetch file content from chunks ===
function fetchFileContent(settings, doc) {
  var children = doc.children || [];
  if (children.length === 0) return Promise.resolve("");

  var body = JSON.stringify({ docs: children.map(function(id) { return { id: id }; }) });
  return couchRequest(settings, "_bulk_get", "POST", body).then(function(result) {
    var chunkMap = {};
    (result.results || []).forEach(function(item) {
      (item.docs || []).forEach(function(d) {
        if (d.ok) chunkMap[d.ok._id] = d.ok.data || "";
      });
    });
    return children.map(function(id) { return chunkMap[id] || ""; }).join("");
  });
}

// === Split content into chunks ===
function splitIntoChunks(content) {
  var maxSize = 250;
  var minSize = 20;
  if (content.length <= maxSize) return [content];
  var chunks = [];
  var pos = 0;
  while (pos < content.length) {
    var end = Math.min(pos + maxSize, content.length);
    if (end < content.length) {
      var nlPos = content.lastIndexOf("\n", end);
      if (nlPos > pos + minSize) end = nlPos + 1;
    }
    chunks.push(content.slice(pos, end));
    pos = end;
  }
  return chunks;
}

// === Push a file to CouchDB ===
function pushFile(settings, filePath, content, existingDoc, fileMtime, fileSize) {
  var now = Date.now();
  var mtime = fileMtime || now;
  var size = fileSize || new Blob([content]).size;

  var docIdPromise = existingDoc && existingDoc._id
    ? Promise.resolve(existingDoc._id)
    : pathToDocId(filePath, settings.passphrase);

  return docIdPromise.then(function(docId) {
    var chunkTexts = splitIntoChunks(content);

    // Generate chunk IDs (async, SHA-256 based)
    var chunkPromises = chunkTexts.map(function(text, i) {
      return generateChunkId(text + filePath, i).then(function(id) {
        return { _id: id, data: text, type: "leaf" };
      });
    });

    return Promise.all(chunkPromises).then(function(chunkDocs) {
      var fileDoc = {
        _id: docId,
        children: chunkDocs.map(function(c) { return c._id; }),
        path: filePath,
        ctime: existingDoc ? existingDoc.ctime : now,
        mtime: mtime,
        size: size,
        type: "plain",
        eden: existingDoc ? (existingDoc.eden || {}) : {},
      };
      if (existingDoc && existingDoc._rev) fileDoc._rev = existingDoc._rev;

      var allDocs = chunkDocs.concat([fileDoc]);
      return couchRequest(settings, "_bulk_docs", "POST", JSON.stringify({ docs: allDocs })).then(function(result) {
        var errors = result.filter(function(r) {
          return r.error && !(r.error === "conflict" && r.id && r.id.indexOf("h:") === 0);
        });
        return { ok: result.length - errors.length, errors: errors };
      });
    });
  });
}

// === Soft-delete in CouchDB ===
function softDeleteInDB(settings, doc) {
  var updated = Object.assign({}, doc, { deleted: true, mtime: Date.now() });
  return couchRequest(settings, encodeURIComponent(doc._id), "PUT", JSON.stringify(updated));
}

// ================================================================
// LiteSync Plugin
// ================================================================

var LiteSyncPlugin = /** @class */ (function(_super) {
  function LiteSyncPlugin() {
    var _this = _super !== null && _super.apply(this, arguments) || this;
    _this.settings = Object.assign({}, DEFAULT_SETTINGS);
    _this.statusBarEl = null;
    _this.syncing = false;
    _this.syncTimer = null;
    return _this;
  }

  LiteSyncPlugin.prototype = Object.create(_super.prototype);
  LiteSyncPlugin.prototype.constructor = LiteSyncPlugin;

  // === Lifecycle ===
  LiteSyncPlugin.prototype.onload = function() {
    var _this = this;
    console.log("LiteSync: loading plugin");

    return this.loadSettings().then(function() {
      _this.statusBarEl = _this.addStatusBarItem();
      _this.statusBarEl.addClass("litesync-status");
      _this.setStatus("idle", "LiteSync: idle");

      _this.addSettingTab(new LiteSyncSettingTab(_this.app, _this));

      _this.addCommand({
        id: "litesync-sync", name: "Sync now (bidirectional)",
        callback: function() { _this.doSync(); },
      });
      _this.addCommand({
        id: "litesync-pull", name: "Pull from remote",
        callback: function() { _this.doPull(); },
      });
      _this.addCommand({
        id: "litesync-push", name: "Push to remote",
        callback: function() { _this.doPush(); },
      });
      _this.addCommand({
        id: "litesync-fetch", name: "Fetch (full download)",
        callback: function() { _this.doFetch(); },
      });
      _this.addCommand({
        id: "litesync-prune", name: "Prune zombie docs",
        callback: function() { _this.doPrune(); },
      });
      _this.addCommand({
        id: "litesync-status", name: "Show sync status",
        callback: function() { _this.showStatus(); },
      });

      // Start periodic sync timer if enabled
      if (_this.settings.autoSync && _this.settings.syncInterval > 0 && _this.settings.couchdbUri) {
        _this.startSyncTimer();
      }

      console.log("LiteSync: loaded");
    });
  };

  LiteSyncPlugin.prototype.onunload = function() {
    if (this.syncTimer) clearInterval(this.syncTimer);
    console.log("LiteSync: unloading");
  };

  // === Periodic sync timer ===
  LiteSyncPlugin.prototype.startSyncTimer = function() {
    var _this = this;
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.settings.syncInterval > 0) {
      this.syncTimer = setInterval(function() {
        _this.doSync();
      }, this.settings.syncInterval * 1000);
    }
  };

  LiteSyncPlugin.prototype.stopSyncTimer = function() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  };

  // === Settings ===
  LiteSyncPlugin.prototype.loadSettings = function() {
    var _this = this;
    return this.loadData().then(function(data) {
      _this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
    });
  };

  LiteSyncPlugin.prototype.saveSettings = function() {
    return this.saveData(this.settings);
  };

  // === Status bar ===
  LiteSyncPlugin.prototype.setStatus = function(state, text) {
    if (!this.statusBarEl) return;
    this.statusBarEl.setText(text);
    this.statusBarEl.removeClass("syncing", "error", "ok");
    if (state === "syncing") this.statusBarEl.addClass("syncing");
    else if (state === "error") this.statusBarEl.addClass("error");
    else if (state === "ok") this.statusBarEl.addClass("ok");
  };

  // === Guard ===
  LiteSyncPlugin.prototype._checkReady = function() {
    if (this.syncing) {
      new obsidian.Notice("LiteSync: Already syncing, please wait");
      return false;
    }
    if (!this.settings.couchdbUri) {
      new obsidian.Notice("LiteSync: Please configure CouchDB connection first");
      return false;
    }
    return true;
  };

  // === Helper: read file content (text or binary→base64) ===
  LiteSyncPlugin.prototype._readFileContent = function(file) {
    var vault = this.app.vault;
    if (isBinaryFile(file.path)) {
      return vault.readBinary(file).then(function(buf) {
        return arrayBufferToBase64(buf);
      });
    }
    return vault.read(file);
  };

  // === Helper: write content to vault (text or binary) ===
  LiteSyncPlugin.prototype._writeContent = function(filePath, content) {
    var vault = this.app.vault;
    var dir = filePath.substring(0, filePath.lastIndexOf("/"));
    var ensureDir = dir ? vault.adapter.mkdir(dir).catch(function() {}) : Promise.resolve();
    return ensureDir.then(function() {
      if (isBinaryFile(filePath) && content) {
        return vault.adapter.writeBinary(filePath, decodeBinaryContent(content));
      }
      return vault.adapter.write(filePath, content);
    });
  };

  // === Helper: get latest _rev before push ===
  LiteSyncPlugin.prototype._getLatestDoc = function(existingDoc) {
    if (!existingDoc || !existingDoc._id) return Promise.resolve(null);
    var s = this.settings;
    return couchRequest(s, encodeURIComponent(existingDoc._id)).then(function(latest) {
      if (latest && latest._rev) existingDoc._rev = latest._rev;
      return existingDoc;
    }).catch(function() {
      return existingDoc;
    });
  };

  // ================================================================
  // FETCH - Full download from remote (first-time setup)
  // ================================================================
  LiteSyncPlugin.prototype.doFetch = function() {
    if (!this._checkReady()) return Promise.resolve();
    var _this = this;
    var s = this.settings;
    this.syncing = true;
    this.setStatus("syncing", "LiteSync: fetching...");

    return fetchAllRemoteDocs(s).then(function(remoteDocs) {
      var total = remoteDocs.length;
      var success = 0, skipped = 0, errors = 0;

      function next(i) {
        if (i >= total) return Promise.resolve();
        var doc = remoteDocs[i].doc;
        var filePath = doc.path || "";
        if (!filePath || doc.deleted) { skipped++; return next(i + 1); }

        _this.setStatus("syncing", "LiteSync: fetch " + (i + 1) + "/" + total);

        // Skip if local file exists with same size
        return _this.app.vault.adapter.stat(filePath).then(function(stat) {
          if (stat && stat.size === (doc.size || -1)) { skipped++; return next(i + 1); }
          return pull(i);
        }).catch(function() {
          return pull(i);
        });

        function pull(idx) {
          var d = remoteDocs[idx].doc;
          return fetchFileContent(s, d).then(function(content) {
            return _this._writeContent(d.path, content);
          }).then(function() {
            success++;
            return next(idx + 1);
          }).catch(function(err) {
            console.error("LiteSync fetch error:", d.path, err);
            errors++;
            return next(idx + 1);
          });
        }
      }

      return next(0).then(function() {
        return { success: success, skipped: skipped, errors: errors };
      });
    }).then(function(r) {
      _this.syncing = false;
      var msg = "LiteSync fetch: " + r.success + " downloaded, " + r.skipped + " skipped";
      if (r.errors > 0) msg += ", " + r.errors + " errors";
      _this.setStatus(r.errors > 0 ? "error" : "ok", msg);
      new obsidian.Notice(msg, 8000);
    }).catch(function(err) {
      _this.syncing = false;
      _this.setStatus("error", "LiteSync: fetch error");
      new obsidian.Notice("LiteSync fetch error: " + err.message);
      console.error("LiteSync fetch error:", err);
    });
  };

  // ================================================================
  // PULL - Remote → Local only
  // ================================================================
  LiteSyncPlugin.prototype.doPull = function() {
    if (!this._checkReady()) return Promise.resolve();
    var _this = this;
    var s = this.settings;
    var vault = this.app.vault;
    this.syncing = true;
    this.setStatus("syncing", "LiteSync: pulling...");

    return fetchAllRemoteDocs(s).then(function(remoteDocs) {
      var remoteByPath = {};
      remoteDocs.forEach(function(row) {
        if (row.doc.path && !row.doc.deleted) remoteByPath[row.doc.path] = row.doc;
      });

      var localByPath = {};
      vault.getFiles().forEach(function(f) { localByPath[f.path] = f; });

      var toPull = [];
      Object.keys(remoteByPath).forEach(function(p) {
        var remote = remoteByPath[p];
        var local = localByPath[p];
        if (!local) {
          toPull.push({ path: p, doc: remote });
        } else if (remote.size !== local.stat.size) {
          if ((remote.mtime || 0) > (local.stat.mtime || 0)) {
            toPull.push({ path: p, doc: remote });
          }
        }
      });

      var pulled = 0, errors = 0;

      function next(i) {
        if (i >= toPull.length) return Promise.resolve();
        _this.setStatus("syncing", "LiteSync: pull " + (i + 1) + "/" + toPull.length);
        var item = toPull[i];

        return fetchFileContent(s, item.doc).then(function(content) {
          return _this._writeContent(item.path, content);
        }).then(function() {
          pulled++;
          return next(i + 1);
        }).catch(function(err) {
          console.error("LiteSync pull error:", item.path, err);
          errors++;
          return next(i + 1);
        });
      }

      return next(0).then(function() {
        return { pulled: pulled, errors: errors };
      });
    }).then(function(r) {
      _this.syncing = false;
      var msg = "LiteSync pull: " + r.pulled + " pulled";
      if (r.errors > 0) msg += ", " + r.errors + " errors";
      _this.setStatus(r.errors > 0 ? "error" : "ok", msg);
      new obsidian.Notice(msg, 5000);
    }).catch(function(err) {
      _this.syncing = false;
      _this.setStatus("error", "LiteSync: pull error");
      new obsidian.Notice("LiteSync pull error: " + err.message);
      console.error("LiteSync pull error:", err);
    });
  };

  // ================================================================
  // PUSH - Local → Remote only
  // ================================================================
  LiteSyncPlugin.prototype.doPush = function() {
    if (!this._checkReady()) return Promise.resolve();
    var _this = this;
    var s = this.settings;
    var vault = this.app.vault;
    this.syncing = true;
    this.setStatus("syncing", "LiteSync: pushing...");

    return fetchAllRemoteDocs(s).then(function(remoteDocs) {
      var remoteByPath = {};
      remoteDocs.forEach(function(row) {
        if (row.doc.path && !row.doc.deleted) remoteByPath[row.doc.path] = row.doc;
      });

      var localFiles = vault.getFiles();
      var toPush = [];

      localFiles.forEach(function(f) {
        var remote = remoteByPath[f.path];
        if (!remote) {
          toPush.push({ path: f.path, file: f, doc: null });
        } else if (remote.size !== f.stat.size) {
          if ((f.stat.mtime || 0) > (remote.mtime || 0)) {
            toPush.push({ path: f.path, file: f, doc: remote });
          }
        }
      });

      var pushed = 0, errors = 0;

      function next(i) {
        if (i >= toPush.length) return Promise.resolve();
        _this.setStatus("syncing", "LiteSync: push " + (i + 1) + "/" + toPush.length);
        var item = toPush[i];

        return _this._readFileContent(item.file).then(function(content) {
          return _this._getLatestDoc(item.doc).then(function(doc) {
            return pushFile(s, item.path, content, doc, item.file.stat.mtime, item.file.stat.size);
          });
        }).then(function(pushResult) {
          if (pushResult.errors.length > 0) {
            console.error("LiteSync push errors:", item.path, pushResult.errors);
            errors++;
          } else {
            pushed++;
          }
          return next(i + 1);
        }).catch(function(err) {
          console.error("LiteSync push error:", item.path, err);
          errors++;
          return next(i + 1);
        });
      }

      return next(0).then(function() {
        return { pushed: pushed, errors: errors };
      });
    }).then(function(r) {
      _this.syncing = false;
      var msg = "LiteSync push: " + r.pushed + " pushed";
      if (r.errors > 0) msg += ", " + r.errors + " errors";
      _this.setStatus(r.errors > 0 ? "error" : "ok", msg);
      new obsidian.Notice(msg, 5000);
    }).catch(function(err) {
      _this.syncing = false;
      _this.setStatus("error", "LiteSync: push error");
      new obsidian.Notice("LiteSync push error: " + err.message);
      console.error("LiteSync push error:", err);
    });
  };

  // ================================================================
  // SYNC - Bidirectional (newer wins)
  // ================================================================
  LiteSyncPlugin.prototype.doSync = function() {
    if (!this._checkReady()) return Promise.resolve();
    var _this = this;
    var s = this.settings;
    var vault = this.app.vault;
    this.syncing = true;
    this.setStatus("syncing", "LiteSync: syncing...");

    return fetchAllRemoteDocs(s).then(function(remoteDocs) {
      var remoteByPath = {};
      remoteDocs.forEach(function(row) {
        if (row.doc.path && !row.doc.deleted) remoteByPath[row.doc.path] = row.doc;
      });

      var localFiles = vault.getFiles();
      var localByPath = {};
      localFiles.forEach(function(f) { localByPath[f.path] = f; });

      var allPaths = {};
      Object.keys(remoteByPath).forEach(function(p) { allPaths[p] = true; });
      localFiles.forEach(function(f) { allPaths[f.path] = true; });

      var toPull = [];
      var toPush = [];

      Object.keys(allPaths).forEach(function(p) {
        var remote = remoteByPath[p];
        var local = localByPath[p];

        if (remote && !local) {
          toPull.push({ path: p, doc: remote });
        } else if (local && !remote) {
          toPush.push({ path: p, file: local, doc: null });
        } else if (remote && local) {
          if (remote.size === local.stat.size) return; // same size, skip
          var rMtime = remote.mtime || 0;
          var lMtime = local.stat.mtime || 0;
          if (lMtime > rMtime) {
            toPush.push({ path: p, file: local, doc: remote });
          } else if (rMtime > lMtime) {
            toPull.push({ path: p, doc: remote });
          }
        }
      });

      var result = { pulled: 0, pushed: 0, errors: 0 };
      var totalOps = toPull.length + toPush.length;
      var done = 0;

      function pullNext(i) {
        if (i >= toPull.length) return Promise.resolve();
        done++;
        _this.setStatus("syncing", "LiteSync: sync " + done + "/" + totalOps);
        var item = toPull[i];

        return fetchFileContent(s, item.doc).then(function(content) {
          return _this._writeContent(item.path, content);
        }).then(function() {
          result.pulled++;
          return pullNext(i + 1);
        }).catch(function(err) {
          console.error("LiteSync pull error:", item.path, err);
          result.errors++;
          return pullNext(i + 1);
        });
      }

      function pushNext(i) {
        if (i >= toPush.length) return Promise.resolve();
        done++;
        _this.setStatus("syncing", "LiteSync: sync " + done + "/" + totalOps);
        var item = toPush[i];

        return _this._readFileContent(item.file).then(function(content) {
          return _this._getLatestDoc(item.doc).then(function(doc) {
            return pushFile(s, item.path, content, doc, item.file.stat.mtime, item.file.stat.size);
          });
        }).then(function(pushResult) {
          if (pushResult.errors.length > 0) {
            console.error("LiteSync push errors:", item.path, pushResult.errors);
            result.errors++;
          } else {
            result.pushed++;
          }
          return pushNext(i + 1);
        }).catch(function(err) {
          console.error("LiteSync push error:", item.path, err);
          result.errors++;
          return pushNext(i + 1);
        });
      }

      return pullNext(0).then(function() {
        return pushNext(0);
      }).then(function() {
        return result;
      });
    }).then(function(r) {
      _this.syncing = false;
      var msg = "LiteSync: " + r.pulled + " pulled, " + r.pushed + " pushed";
      if (r.errors > 0) msg += ", " + r.errors + " errors";
      _this.setStatus(r.errors > 0 ? "error" : "ok", msg);
      if (r.pulled + r.pushed > 0 || r.errors > 0) {
        new obsidian.Notice(msg, 5000);
      }
    }).catch(function(err) {
      _this.syncing = false;
      _this.setStatus("error", "LiteSync: sync error");
      new obsidian.Notice("LiteSync sync error: " + err.message);
      console.error("LiteSync sync error:", err);
    });
  };

  // ================================================================
  // PRUNE - Remove zombie docs (in DB but not in vault)
  // ================================================================
  LiteSyncPlugin.prototype.doPrune = function() {
    if (!this._checkReady()) return Promise.resolve();
    var _this = this;
    var s = this.settings;
    var vault = this.app.vault;
    this.syncing = true;
    this.setStatus("syncing", "LiteSync: scanning for zombies...");

    return fetchAllRemoteDocs(s).then(function(remoteDocs) {
      var localPaths = {};
      vault.getFiles().forEach(function(f) { localPaths[f.path] = true; });

      var zombies = [];
      remoteDocs.forEach(function(row) {
        var doc = row.doc;
        if (doc.path && !doc.deleted && !localPaths[doc.path]) {
          zombies.push({ path: doc.path, doc: doc });
        }
      });

      if (zombies.length === 0) {
        new obsidian.Notice("LiteSync: No zombie docs found. DB is clean.");
        return { deleted: 0, errors: 0 };
      }

      new obsidian.Notice("LiteSync: Pruning " + zombies.length + " zombie docs...", 5000);
      var deleted = 0, errors = 0;

      function next(i) {
        if (i >= zombies.length) return Promise.resolve();
        _this.setStatus("syncing", "LiteSync: prune " + (i + 1) + "/" + zombies.length);

        return softDeleteInDB(s, zombies[i].doc).then(function() {
          deleted++;
          return next(i + 1);
        }).catch(function(err) {
          console.error("LiteSync prune error:", zombies[i].path, err);
          errors++;
          return next(i + 1);
        });
      }

      return next(0).then(function() {
        return { deleted: deleted, errors: errors };
      });
    }).then(function(r) {
      _this.syncing = false;
      var msg = "LiteSync prune: " + r.deleted + " deleted";
      if (r.errors > 0) msg += ", " + r.errors + " errors";
      _this.setStatus(r.errors > 0 ? "error" : "ok", msg);
      new obsidian.Notice(msg, 5000);
    }).catch(function(err) {
      _this.syncing = false;
      _this.setStatus("error", "LiteSync: prune error");
      new obsidian.Notice("LiteSync prune error: " + err.message);
      console.error("LiteSync prune error:", err);
    });
  };

  // === Status ===
  LiteSyncPlugin.prototype.showStatus = function() {
    if (!this.settings.couchdbUri) {
      new obsidian.Notice("LiteSync: Not configured");
      return;
    }
    couchRequest(this.settings, "").then(function(data) {
      var msg = "LiteSync Status\n"
        + "DB: " + data.db_name + "\n"
        + "Docs: " + data.doc_count + "\n"
        + "Size: " + Math.floor(data.sizes.file / 1024 / 1024) + " MB";
      new obsidian.Notice(msg, 10000);
    }).catch(function(err) {
      new obsidian.Notice("LiteSync: Cannot connect - " + err.message);
    });
  };

  return LiteSyncPlugin;
}(obsidian.Plugin));

// ================================================================
// Settings Tab
// ================================================================

var LiteSyncSettingTab = /** @class */ (function(_super) {
  function LiteSyncSettingTab(app, plugin) {
    var _this = _super.call(this, app, plugin) || this;
    _this.plugin = plugin;
    return _this;
  }

  LiteSyncSettingTab.prototype = Object.create(_super.prototype);
  LiteSyncSettingTab.prototype.constructor = LiteSyncSettingTab;

  LiteSyncSettingTab.prototype.display = function() {
    var el = this.containerEl;
    var plugin = this.plugin;
    var s = plugin.settings;

    el.empty();
    el.createEl("h2", { text: "LiteSync Settings" });

    // Connection
    el.createEl("h3", { text: "CouchDB Connection" });

    new obsidian.Setting(el)
      .setName("Server URI")
      .setDesc("e.g. https://your-server/couchdb")
      .addText(function(text) {
        text.setPlaceholder("https://...").setValue(s.couchdbUri)
          .onChange(function(v) { s.couchdbUri = v; plugin.saveSettings(); });
      });

    new obsidian.Setting(el)
      .setName("Username")
      .addText(function(text) {
        text.setValue(s.couchdbUser)
          .onChange(function(v) { s.couchdbUser = v; plugin.saveSettings(); });
      });

    new obsidian.Setting(el)
      .setName("Password")
      .addText(function(text) {
        text.inputEl.type = "password";
        text.setValue(s.couchdbPassword)
          .onChange(function(v) { s.couchdbPassword = v; plugin.saveSettings(); });
      });

    new obsidian.Setting(el)
      .setName("Database name")
      .addText(function(text) {
        text.setValue(s.couchdbDbname)
          .onChange(function(v) { s.couchdbDbname = v; plugin.saveSettings(); });
      });

    new obsidian.Setting(el)
      .setName("Passphrase")
      .setDesc("Must match the passphrase used in Self-hosted LiveSync for path obfuscation")
      .addText(function(text) {
        text.inputEl.type = "password";
        text.setPlaceholder("(optional)").setValue(s.passphrase)
          .onChange(function(v) { s.passphrase = v; plugin.saveSettings(); });
      });

    new obsidian.Setting(el)
      .setName("Device name")
      .setDesc("Identify this device in sync")
      .addText(function(text) {
        text.setValue(s.deviceName)
          .onChange(function(v) { s.deviceName = v; plugin.saveSettings(); });
      });

    // Periodic sync
    el.createEl("h3", { text: "Periodic Sync" });

    new obsidian.Setting(el)
      .setName("Enable periodic sync")
      .setDesc("Automatically run bidirectional sync on a timer")
      .addToggle(function(toggle) {
        toggle.setValue(s.autoSync)
          .onChange(function(v) {
            s.autoSync = v;
            plugin.saveSettings();
            if (v && s.syncInterval > 0 && s.couchdbUri) {
              plugin.startSyncTimer();
            } else {
              plugin.stopSyncTimer();
            }
          });
      });

    new obsidian.Setting(el)
      .setName("Sync interval (seconds)")
      .setDesc("How often to sync. Default: 300 (5 minutes)")
      .addText(function(text) {
        text.setValue(String(s.syncInterval))
          .onChange(function(v) {
            var val = parseInt(v) || 0;
            s.syncInterval = val;
            plugin.saveSettings();
            if (s.autoSync && val > 0) {
              plugin.startSyncTimer();
            } else {
              plugin.stopSyncTimer();
            }
          });
      });

    // Actions
    el.createEl("h3", { text: "Actions" });

    new obsidian.Setting(el)
      .setName("Test connection")
      .addButton(function(btn) {
        btn.setButtonText("Test").onClick(function() {
          plugin.showStatus();
        });
      });

    new obsidian.Setting(el)
      .setName("Fetch (full download)")
      .setDesc("Download all files from remote. Use for first-time setup.")
      .addButton(function(btn) {
        btn.setButtonText("Fetch").onClick(function() {
          plugin.doFetch();
        });
      });

    new obsidian.Setting(el)
      .setName("Sync now")
      .setDesc("Bidirectional sync (newer wins)")
      .addButton(function(btn) {
        btn.setButtonText("Sync").setCta().onClick(function() {
          plugin.doSync();
        });
      });

    new obsidian.Setting(el)
      .setName("Pull from remote")
      .setDesc("Remote \u2192 Local only")
      .addButton(function(btn) {
        btn.setButtonText("Pull").onClick(function() {
          plugin.doPull();
        });
      });

    new obsidian.Setting(el)
      .setName("Push to remote")
      .setDesc("Local \u2192 Remote only")
      .addButton(function(btn) {
        btn.setButtonText("Push").onClick(function() {
          plugin.doPush();
        });
      });

    new obsidian.Setting(el)
      .setName("Prune zombie docs")
      .setDesc("Soft-delete docs from DB that no longer exist locally")
      .addButton(function(btn) {
        btn.setButtonText("Prune").setWarning().onClick(function() {
          plugin.doPrune();
        });
      });
  };

  return LiteSyncSettingTab;
}(obsidian.PluginSettingTab));

// === Export ===
module.exports = LiteSyncPlugin;

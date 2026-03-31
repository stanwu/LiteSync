/**
 * LiteSync - Lightweight CouchDB sync plugin for Obsidian
 * Compatible with Self-hosted LiveSync database format.
 * Written in ES2017 for old Electron compatibility.
 */

// Obsidian module (provided by Obsidian runtime)
var obsidian = require("obsidian");

// === Default settings ===
var DEFAULT_SETTINGS = {
  couchdbUri: "",
  couchdbUser: "",
  couchdbPassword: "",
  couchdbDbname: "obsidianlivesync",
  passphrase: "",
  deviceName: "",
  syncInterval: 300,  // seconds, 0 = manual only
  autoSync: false,
  usePathObfuscation: true,
};

// === Helper: CouchDB HTTP request ===
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

// === Helper: Fetch all file docs from CouchDB ===
function fetchAllRemoteDocs(settings) {
  var allDocs = [];
  var batchSize = 200;

  function fetchBatch(skip) {
    var path = "_all_docs?include_docs=true"
      + "&startkey=" + encodeURIComponent('"f:"')
      + "&endkey=" + encodeURIComponent('"f:\ufff0"')
      + "&limit=" + batchSize
      + "&skip=" + skip;
    return couchRequest(settings, path).then(function(data) {
      if (!data || !data.rows || data.rows.length === 0) return allDocs;
      allDocs = allDocs.concat(data.rows);
      if (data.rows.length < batchSize) return allDocs;
      return fetchBatch(skip + data.rows.length);
    });
  }

  return fetchBatch(0);
}

// === Helper: Fetch file content from chunks ===
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

// === Helper: Split content into chunks ===
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

// === Helper: Generate chunk ID ===
function generateChunkId(content, index) {
  // Simple hash using built-in crypto
  var str = content + "|" + index;
  var hash = 0;
  for (var i = 0; i < str.length; i++) {
    var ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash = hash & hash; // Convert to 32bit int
  }
  // Use abs and base36
  var abs = Math.abs(hash);
  return "h:" + abs.toString(36) + index.toString(36);
}

// === Helper: Push a file to CouchDB ===
function pushFile(settings, filePath, content, existingDoc) {
  var now = Date.now();
  var size = new Blob([content]).size;

  var docId = existingDoc ? existingDoc._id : "f:litesync_" + simpleHash(filePath);

  var chunkTexts = splitIntoChunks(content);
  var chunkDocs = chunkTexts.map(function(text, i) {
    return { _id: generateChunkId(text + filePath, i), data: text, type: "leaf" };
  });

  var fileDoc = {
    _id: docId,
    children: chunkDocs.map(function(c) { return c._id; }),
    path: filePath,
    ctime: existingDoc ? existingDoc.ctime : now,
    mtime: now,
    size: size,
    type: "plain",
    eden: {},
  };
  if (existingDoc && existingDoc._rev) fileDoc._rev = existingDoc._rev;

  var allDocs = chunkDocs.concat([fileDoc]);
  return couchRequest(settings, "_bulk_docs", "POST", JSON.stringify({ docs: allDocs })).then(function(result) {
    // Chunk conflicts are OK (immutable, already exists)
    var errors = result.filter(function(r) {
      return r.error && !(r.error === "conflict" && r.id && r.id.indexOf("h:") === 0);
    });
    return { ok: result.length - errors.length, errors: errors };
  });
}

// === Helper: Simple string hash ===
function simpleHash(str) {
  var hash = 5381;
  for (var i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// === Helper: Soft-delete in CouchDB ===
function softDeleteInDB(settings, doc) {
  var updated = Object.assign({}, doc, { deleted: true, mtime: Date.now() });
  return couchRequest(settings, encodeURIComponent(doc._id), "PUT", JSON.stringify(updated));
}

// ================================================================
// LiteSync Plugin
// ================================================================

var LiteSyncPlugin = /** @class */ (function(_super) {
  // Extend obsidian.Plugin
  function LiteSyncPlugin() {
    var _this = _super !== null && _super.apply(this, arguments) || this;
    _this.settings = Object.assign({}, DEFAULT_SETTINGS);
    _this.statusBarEl = null;
    _this.syncTimer = null;
    _this.syncing = false;
    _this.pendingSync = false;
    _this.remoteDocCache = null;
    return _this;
  }

  // Inherit from Plugin
  LiteSyncPlugin.prototype = Object.create(_super.prototype);
  LiteSyncPlugin.prototype.constructor = LiteSyncPlugin;

  // === Plugin lifecycle ===
  LiteSyncPlugin.prototype.onload = function() {
    var _this = this;
    console.log("LiteSync: loading plugin");

    return this.loadSettings().then(function() {
      // Status bar
      _this.statusBarEl = _this.addStatusBarItem();
      _this.statusBarEl.addClass("litesync-status");
      _this.setStatus("idle", "LiteSync: idle");

      // Settings tab
      _this.addSettingTab(new LiteSyncSettingTab(_this.app, _this));

      // Commands
      _this.addCommand({
        id: "litesync-sync",
        name: "Sync now",
        callback: function() { _this.doSync(); },
      });
      _this.addCommand({
        id: "litesync-pull",
        name: "Pull from remote",
        callback: function() { _this.doPull(); },
      });
      _this.addCommand({
        id: "litesync-push",
        name: "Push to remote",
        callback: function() { _this.doPush(); },
      });
      _this.addCommand({
        id: "litesync-status",
        name: "Show sync status",
        callback: function() { _this.showStatus(); },
      });

      // Vault events for real-time sync
      _this.registerEvent(_this.app.vault.on("modify", function(file) {
        if (_this.settings.autoSync) _this.scheduleSync(2000);
      }));
      _this.registerEvent(_this.app.vault.on("delete", function(file) {
        if (_this.settings.autoSync) _this.handleLocalDelete(file.path);
      }));
      _this.registerEvent(_this.app.vault.on("rename", function(file, oldPath) {
        if (_this.settings.autoSync) _this.handleLocalRename(file.path, oldPath);
      }));
      _this.registerEvent(_this.app.vault.on("create", function(file) {
        if (_this.settings.autoSync) _this.scheduleSync(2000);
      }));

      // Auto sync timer
      if (_this.settings.autoSync && _this.settings.syncInterval > 0) {
        _this.startSyncTimer();
      }

      // Initial sync on load
      if (_this.settings.autoSync && _this.settings.couchdbUri) {
        setTimeout(function() { _this.doSync(); }, 3000);
      }

      console.log("LiteSync: loaded");
    });
  };

  LiteSyncPlugin.prototype.onunload = function() {
    console.log("LiteSync: unloading");
    if (this.syncTimer) clearInterval(this.syncTimer);
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

  // === Sync timer ===
  LiteSyncPlugin.prototype.startSyncTimer = function() {
    var _this = this;
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.settings.syncInterval > 0) {
      this.syncTimer = setInterval(function() {
        _this.doSync();
      }, this.settings.syncInterval * 1000);
    }
  };

  LiteSyncPlugin.prototype.scheduleSync = function(delayMs) {
    var _this = this;
    if (this.pendingSync) return;
    this.pendingSync = true;
    setTimeout(function() {
      _this.pendingSync = false;
      _this.doSync();
    }, delayMs);
  };

  // === Core sync ===
  LiteSyncPlugin.prototype.doSync = function() {
    if (this.syncing) return Promise.resolve();
    if (!this.settings.couchdbUri) {
      new obsidian.Notice("LiteSync: Please configure CouchDB connection first");
      return Promise.resolve();
    }

    var _this = this;
    this.syncing = true;
    this.setStatus("syncing", "LiteSync: syncing...");
    this.remoteDocCache = null;

    return this._sync().then(function(result) {
      _this.syncing = false;
      var msg = "LiteSync: " + result.pulled + " pulled, " + result.pushed + " pushed";
      if (result.deleted > 0) msg += ", " + result.deleted + " deleted";
      if (result.moved > 0) msg += ", " + result.moved + " moved";
      if (result.errors > 0) msg += ", " + result.errors + " errors";
      _this.setStatus(result.errors > 0 ? "error" : "ok", msg);
      if (result.pulled + result.pushed + result.deleted + result.moved > 0) {
        new obsidian.Notice(msg);
      }
      return result;
    }).catch(function(err) {
      _this.syncing = false;
      _this.setStatus("error", "LiteSync: error");
      new obsidian.Notice("LiteSync error: " + err.message);
      console.error("LiteSync sync error:", err);
    });
  };

  LiteSyncPlugin.prototype._sync = function() {
    var _this = this;
    var s = this.settings;
    var vault = this.app.vault;
    var result = { pulled: 0, pushed: 0, deleted: 0, moved: 0, errors: 0 };

    // Fetch remote docs
    return fetchAllRemoteDocs(s).then(function(remoteDocs) {
      _this.remoteDocCache = {};
      var remoteByPath = {};
      remoteDocs.forEach(function(row) {
        var doc = row.doc;
        if (doc.path && !doc.deleted) {
          remoteByPath[doc.path] = doc;
          _this.remoteDocCache[doc.path] = doc;
        }
      });

      // Get local files
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
          // Remote only → pull
          toPull.push({ path: p, doc: remote });
        } else if (local && !remote) {
          // Local only → push
          toPush.push({ path: p, file: local });
        } else if (remote && local) {
          // Both exist → compare
          if (remote.size === local.stat.size) return; // same size, skip
          var remoteMtime = remote.mtime || 0;
          var localMtime = local.stat.mtime || 0;
          if (localMtime > remoteMtime) {
            toPush.push({ path: p, file: local, doc: remote });
          } else if (remoteMtime > localMtime) {
            toPull.push({ path: p, doc: remote });
          }
        }
      });

      // Process pulls sequentially
      function processPulls(index) {
        if (index >= toPull.length) return Promise.resolve();
        var item = toPull[index];
        return fetchFileContent(s, item.doc).then(function(content) {
          var adapter = vault.adapter;
          var dir = item.path.substring(0, item.path.lastIndexOf("/"));
          var ensureDir = dir ? adapter.mkdir(dir).catch(function() {}) : Promise.resolve();
          return ensureDir.then(function() {
            return adapter.write(item.path, content);
          }).then(function() {
            result.pulled++;
            return processPulls(index + 1);
          });
        }).catch(function(err) {
          console.error("LiteSync pull error:", item.path, err);
          result.errors++;
          return processPulls(index + 1);
        });
      }

      // Process pushes sequentially
      function processPushes(index) {
        if (index >= toPush.length) return Promise.resolve();
        var item = toPush[index];
        return vault.read(item.file).then(function(content) {
          // Find existing doc to get correct _id and _rev
          var existingDoc = item.doc || _this.remoteDocCache[item.path];
          if (existingDoc) {
            // Fetch latest _rev
            return couchRequest(s, encodeURIComponent(existingDoc._id)).then(function(latest) {
              if (latest && latest._rev) existingDoc._rev = latest._rev;
              return pushFile(s, item.path, content, existingDoc);
            }).catch(function() {
              return pushFile(s, item.path, content, existingDoc);
            });
          }
          return pushFile(s, item.path, content, null);
        }).then(function(pushResult) {
          if (pushResult.errors.length > 0) {
            console.error("LiteSync push errors:", item.path, pushResult.errors);
            result.errors++;
          } else {
            result.pushed++;
          }
          return processPushes(index + 1);
        }).catch(function(err) {
          console.error("LiteSync push error:", item.path, err);
          result.errors++;
          return processPushes(index + 1);
        });
      }

      return processPulls(0).then(function() {
        return processPushes(0);
      }).then(function() {
        return result;
      });
    });
  };

  // === Real-time event handlers ===
  LiteSyncPlugin.prototype.handleLocalDelete = function(filePath) {
    var _this = this;
    var s = this.settings;
    if (!s.couchdbUri) return;

    // Find remote doc and soft-delete it
    this._getRemoteDoc(filePath).then(function(doc) {
      if (doc) {
        softDeleteInDB(s, doc).then(function() {
          console.log("LiteSync: soft-deleted", filePath);
        });
      }
    });
  };

  LiteSyncPlugin.prototype.handleLocalRename = function(newPath, oldPath) {
    var _this = this;
    var s = this.settings;
    if (!s.couchdbUri) return;

    this._getRemoteDoc(oldPath).then(function(oldDoc) {
      if (!oldDoc) return;
      // Soft-delete old, push new
      softDeleteInDB(s, oldDoc).then(function() {
        _this.scheduleSync(1000);
      });
    });
  };

  LiteSyncPlugin.prototype._getRemoteDoc = function(filePath) {
    var _this = this;
    if (this.remoteDocCache && this.remoteDocCache[filePath]) {
      return Promise.resolve(this.remoteDocCache[filePath]);
    }
    return fetchAllRemoteDocs(this.settings).then(function(docs) {
      for (var i = 0; i < docs.length; i++) {
        if (docs[i].doc.path === filePath && !docs[i].doc.deleted) {
          return docs[i].doc;
        }
      }
      return null;
    });
  };

  // === Manual commands ===
  LiteSyncPlugin.prototype.doPull = function() {
    new obsidian.Notice("LiteSync: pulling...");
    return this.doSync();
  };

  LiteSyncPlugin.prototype.doPush = function() {
    new obsidian.Notice("LiteSync: pushing...");
    return this.doSync();
  };

  LiteSyncPlugin.prototype.showStatus = function() {
    var _this = this;
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
    var _this = this;
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

    // Sync
    el.createEl("h3", { text: "Sync" });

    new obsidian.Setting(el)
      .setName("Auto sync")
      .setDesc("Automatically sync on file changes and periodically")
      .addToggle(function(toggle) {
        toggle.setValue(s.autoSync)
          .onChange(function(v) {
            s.autoSync = v;
            plugin.saveSettings();
            if (v) plugin.startSyncTimer();
            else if (plugin.syncTimer) clearInterval(plugin.syncTimer);
          });
      });

    new obsidian.Setting(el)
      .setName("Sync interval (seconds)")
      .setDesc("0 = manual only")
      .addText(function(text) {
        text.setValue(String(s.syncInterval))
          .onChange(function(v) {
            s.syncInterval = parseInt(v) || 0;
            plugin.saveSettings();
            plugin.startSyncTimer();
          });
      });

    new obsidian.Setting(el)
      .setName("Device name")
      .setDesc("Identify this device in sync")
      .addText(function(text) {
        text.setValue(s.deviceName)
          .onChange(function(v) { s.deviceName = v; plugin.saveSettings(); });
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
      .setName("Sync now")
      .addButton(function(btn) {
        btn.setButtonText("Sync").setCta().onClick(function() {
          plugin.doSync();
        });
      });
  };

  return LiteSyncSettingTab;
}(obsidian.PluginSettingTab));

// === Export ===
module.exports = LiteSyncPlugin;

// src/dataLoader.js
// Speed build W2 (owner rulings 2026-09-28): the ball-engine site's data loader.
//
// WHAT IT DOES. The site's data is ~28 Parquet files listed in manifest_v2.json
// (each table split into HISTORY / THIS YEAR / RECENT tier files by match date,
// plus one untiered profiles file). This module:
//   1. keeps every file on the member's device (the browser's private file store,
//      "OPFS"), named by its content fingerprint, so a return visit re-downloads
//      ONLY the files that changed (a daily update normally changes one small
//      RECENT file per table);
//   2. downloads everything else in the background, WHOLE files, ~4 at a time, in
//      the owner's order: shared files first → the member's currently selected
//      gender/format (live, as they change the Filters popup) → everything else
//      smallest-first;
//   3. lets any query jump the queue: ensureTables() marks exactly the files a
//      query needs as urgent, starts them at once (background starts pause while
//      urgent work is pending) and reports "x of y bytes" progress;
//   4. verifies every download against the manifest's sha256_12 before it is kept
//      or read — so a file that changed on the server after this page read its
//      catalogue is NEVER mixed with the other tiers (that could double-count a
//      match at a tier boundary); a mismatch is retried once, then fails loudly;
//   5. hands each file to DuckDB (via the injected `register`) and tells the host
//      when a table's files are all in (`onTableReady`, where db.js creates the
//      view over the union of the tier files).
//
// It never reads from the network on DuckDB's behalf: DuckDB only ever sees
// files that are fully on the device (or, when device storage is unavailable, in
// memory). No numbers are computed here.
//
// Every browser API (fetch, OPFS, Web Locks, crypto, DuckDB registration) is
// injected via `deps`, so the queue / priority / tier / stale-cleanup logic is
// exercised in Node with fakes (.orchestrator/_w2_tmp/). db.js wires the real ones.

/** Tier order inside a table's file list. Chronological on purpose: W2 proved
 * (tier_order_check.py) that read_parquet([history, year, recent]) reproduces the
 * original single file ROW-FOR-ROW IN ORDER, so every query sees exactly the row
 * sequence it saw before the split. Untiered files (tier null) sort first. */
export const TIER_RANK = { history: 0, year: 1, recent: 2 };

export const DEFAULT_CONCURRENCY = 4;

/** Background classes (lower downloads first). */
const CLASS_SHARED = 1;
const CLASS_SELECTED = 2;
const CLASS_REST = 3;

/** A failed file is not retried by the BACKGROUND queue for this long (a query
 * that needs it always retries at once). Stops an offline phone from spinning. */
const BACKGROUND_RETRY_COOLDOWN_MS = 30000;

/** How often progress callbacks may fire (ms). */
const PROGRESS_THROTTLE_MS = 150;

/** The name a file is kept under on the device: `<stem>.<sha12>.parquet`.
 * Content-addressed, so a stored file is never overwritten with different
 * content — a changed file is a NEW name, and the old one becomes stale. */
export function deviceNameFor(name, sha12) {
  return `${name.replace(/\.parquet$/i, "")}.${sha12}.parquet`;
}

/** Device names this loader writes (only these are ever deleted as stale). */
const DEVICE_NAME_RE = /\.[0-9a-f]{12}\.parquet$/;

/** First 12 hex chars of SHA-256 over `bytes` (matches export_parquet.py
 * sha256_12), or null when this browser cannot hash (no crypto.subtle — e.g. a
 * non-secure context), in which case only the byte-size check applies. */
export async function sha256Hex12(bytes) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle || typeof subtle.digest !== "function") return null;
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  let hex = "";
  for (let i = 0; i < 6; i++) hex += digest[i].toString(16).padStart(2, "0");
  return hex;
}

/** The delivery-file table name pattern → {gender, bucket}; anything else is a
 * SHARED table (matches, player_matches, fielding_events, player_profiles). */
export function classifyTable(table) {
  const m = /^deliveries_([mf])_(t20|odi|red)$/.exec(table);
  return m ? { shared: false, gender: m[1], bucket: m[2] } : { shared: true, gender: null, bucket: null };
}

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A background failure nobody is waiting on must not surface as an
  // "unhandled rejection"; anyone who awaits `promise` still gets the error.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function userError(message, userMessage, extra = {}) {
  const err = new Error(message);
  err.userMessage = userMessage;
  Object.assign(err, extra);
  return err;
}

function isQuotaError(e) {
  const name = e && e.name;
  return name === "QuotaExceededError" || /quota/i.test(String(e && e.message));
}

/**
 * @param {object} deps
 * @param {string} deps.baseUrl  where the tier files live (ends with "/")
 * @param {Function} deps.fetchImpl  fetch(url, init)
 * @param {Function} [deps.hash]  async (Uint8Array) → sha256_12 hex | null
 * @param {Function} deps.openDirectory  async () → OPFS directory handle | null
 * @param {object|null} [deps.locks]  navigator.locks (or a fake), null = none
 * @param {Function} deps.register  async (name, source) → description; source is
 *   {kind:"file", file} | {kind:"handle", handle} | {kind:"buffer", bytes}
 * @param {Function} deps.onTableReady  async (table, fileNames) → void
 * @param {Function} [deps.syncWrite]  async (deviceName, bytes) → void — writes a
 *   device file where FileSystemFileHandle.createWritable is missing (older Safari)
 * @param {"filereader"|"fsaccess"|"memory"} [deps.ioMode]  how DuckDB reads kept files
 * @param {Function} [deps.emit]  (snapshot) → void, throttled
 * @param {Function} [deps.log]  (...args) → void
 */
export function createDataLoader(deps) {
  const {
    baseUrl,
    fetchImpl,
    hash = sha256Hex12,
    openDirectory,
    locks = null,
    register,
    onTableReady,
    syncWrite = null,
    ioMode = "filereader",
    concurrency = DEFAULT_CONCURRENCY,
    retryDelaysMs = [1000, 3000],
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    emit = () => {},
    log = () => {},
    lockPrefix = "cricdb-data:",
  } = deps;

  /** name → file entry */
  const files = new Map();
  /** table → { name, files: entry[], ready, viewPromise } */
  const tables = new Map();
  /** in-flight ensureTables() requests (the urgent set) */
  const requests = new Set();
  let requestSeq = 0;
  let background = "on"; // "on" | "hold" (awaiting the mobile-data answer) | "off" (declined)
  let priority = { gender: null, buckets: new Set(), sig: "" };
  let dir = null;
  let storage = "memory"; // "device" once the device store opens
  let deviceWritable = true; // false after a quota error: keep the rest in memory
  let scanPromise = null;
  let cleanupPromise = Promise.resolve([]);
  const heldLocks = new Map();
  let emitTimer = null;
  let warnedNoHash = false;

  // ── building the file table ────────────────────────────────────────────────
  function start(manifest) {
    if (scanPromise) return scanPromise;
    const entries = Object.entries((manifest && manifest.files) || {});
    for (const [name, meta] of entries) {
      if (!meta || typeof meta.table !== "string" || !Number.isFinite(meta.bytes) || typeof meta.sha256_12 !== "string") {
        log(`manifest_v2 entry ${name} is incomplete — skipped`);
        continue;
      }
      const f = {
        name,
        table: meta.table,
        tier: meta.tier == null ? null : meta.tier,
        bytes: meta.bytes,
        sha12: meta.sha256_12,
        deviceName: deviceNameFor(name, meta.sha256_12),
        state: "scanning", // scanning | queued | downloading | registering | ready | failed
        loaded: 0,
        needsNetwork: false,
        error: null,
        failedAt: 0,
        deferred: makeDeferred(),
        registeredAs: null,
      };
      files.set(name, f);
      if (!tables.has(f.table)) tables.set(f.table, { name: f.table, files: [], ready: false, viewPromise: null });
      tables.get(f.table).files.push(f);
    }
    for (const t of tables.values()) {
      t.files.sort((a, b) => (TIER_RANK[a.tier] ?? -1) - (TIER_RANK[b.tier] ?? -1) || a.name.localeCompare(b.name));
    }
    scanPromise = scan().catch((e) => {
      // A scan failure must never break the site: queue every unresolved file.
      log("device scan failed — downloading instead", e);
      for (const f of files.values()) if (f.state === "scanning") queue(f);
    });
    return scanPromise;
  }

  /** The DuckDB file names for a table, in tier order (history, year, recent). */
  function filesForTable(table) {
    const t = tables.get(table);
    if (!t) {
      throw userError(
        `manifest_v2.json lists no files for table "${table}"`,
        `The data catalogue is missing the "${table}" files. The data pipeline may not have finished publishing — please try again later.`
      );
    }
    return t.files.map((f) => f.name);
  }

  // ── device scan + stale cleanup ────────────────────────────────────────────
  async function scan() {
    try {
      dir = await openDirectory();
    } catch (e) {
      log("device storage unavailable", e);
      dir = null;
    }
    storage = dir ? "device" : "memory";
    const existing = new Map();
    if (dir) {
      try {
        for await (const [name, handle] of dir.entries()) {
          if (handle && handle.kind === "file") existing.set(name, handle);
        }
      } catch (e) {
        log("could not list device storage", e);
      }
    }
    // Queue every missing file BEFORE any download starts, so the first four
    // start in priority order — not in whatever order the catalogue lists them.
    // (Files not on the device are queued synchronously inside the map below.)
    holdPump = true;
    const scanned = Promise.all(
      [...files.values()].map(async (f) => {
        if (f.state !== "scanning") return;
        const handle = existing.get(f.deviceName);
        if (handle) {
          await holdLock(f.deviceName);
          try {
            const file = await handle.getFile();
            if (file.size === f.bytes) {
              f.state = "registering";
              emitSoon();
              await registerChain(f, deviceSources(handle, file, null));
              markReady(f);
              return;
            }
            log(`${f.deviceName} on device has the wrong size — downloading again`);
          } catch (e) {
            log(`could not use ${f.deviceName} from device storage — downloading again`, e);
          }
        }
        queue(f);
      })
    );
    holdPump = false;
    pump();
    await scanned;
    if (dir) cleanupPromise = cleanupStale(existing);
    pump();
    emitSoon();
  }

  /** Delete OUR files (pattern-matched) that the current catalogue no longer
   * lists — superseded versions. Another tab that still reads one holds a shared
   * Web Lock on it, so the exclusive `ifAvailable` request is refused and the
   * file is left for a later visit. Returns the deleted names. */
  async function cleanupStale(existing) {
    const expected = new Set([...files.values()].map((f) => f.deviceName));
    const deleted = [];
    const jobs = [];
    for (const name of existing.keys()) {
      if (expected.has(name) || !DEVICE_NAME_RE.test(name)) continue;
      const remove = async () => {
        try {
          await dir.removeEntry(name);
          deleted.push(name);
        } catch (e) {
          log(`could not delete stale ${name}`, e);
        }
      };
      if (!locks) {
        jobs.push(remove());
        continue;
      }
      jobs.push(
        Promise.resolve()
          .then(() => locks.request(lockPrefix + name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
            if (lock) await remove();
          }))
          .catch((e) => log(`stale cleanup lock failed for ${name}`, e))
      );
    }
    await Promise.all(jobs);
    return deleted;
  }

  /** Hold a SHARED Web Lock on a device file for the life of the page, so no
   * other tab deletes it as stale while this tab reads it. Resolves once held. */
  function holdLock(deviceName) {
    if (!locks) return Promise.resolve();
    if (heldLocks.has(deviceName)) return heldLocks.get(deviceName);
    const p = new Promise((granted) => {
      try {
        Promise.resolve(
          locks.request(lockPrefix + deviceName, { mode: "shared" }, () => {
            granted();
            return new Promise(() => {}); // never released: held until the page closes
          })
        ).catch(() => granted());
      } catch {
        granted();
      }
    });
    heldLocks.set(deviceName, p);
    return p;
  }

  // ── DuckDB registration (with fallbacks) ──────────────────────────────────
  /** The ways DuckDB can read a kept file, best first. FILEREADER (a File from
   * device storage) is the default: disk-backed range reads, no locks, works in
   * every browser with device storage. FSACCESS is opt-in (exclusive per-file
   * lock, older-Safari quirks). The in-memory copy is the last resort. */
  function deviceSources(handle, file, bytes) {
    const toBuffer = async () => ({ kind: "buffer", bytes: bytes || new Uint8Array(await file.arrayBuffer()) });
    if (ioMode === "memory") return [toBuffer];
    const viaFile = async () => ({ kind: "file", file });
    if (ioMode === "fsaccess") return [async () => ({ kind: "handle", handle }), viaFile, toBuffer];
    return [viaFile, toBuffer];
  }

  async function registerChain(f, candidates) {
    let lastError = null;
    for (const make of candidates) {
      let source;
      try {
        source = await make();
      } catch (e) {
        lastError = e;
        continue;
      }
      try {
        f.registeredAs = (await register(f.name, source)) || source.kind;
        return;
      } catch (e) {
        lastError = e;
        log(`registering ${f.name} as "${source.kind}" failed — trying the next way`, e);
      }
    }
    throw lastError || new Error(`could not register ${f.name}`);
  }

  // ── state transitions ──────────────────────────────────────────────────────
  function queue(f) {
    f.state = "queued";
    f.needsNetwork = true;
    f.loaded = 0;
    f.error = null;
    emitSoon();
    pump();
  }

  function markReady(f) {
    f.state = "ready";
    f.loaded = f.bytes;
    f.error = null;
    f.deferred.resolve();
    emitSoon();
    const t = tables.get(f.table);
    // Create the table's view as soon as ALL its files are in, even if nobody
    // is waiting yet — a later query then finds it ready.
    if (t && t.files.every((x) => x.state === "ready")) {
      tableReady(t).catch((e) => log(`table ${t.name} could not be prepared`, e));
    }
    pump();
  }

  function failFile(f, err) {
    f.state = "failed";
    f.error = err;
    f.failedAt = now();
    f.loaded = 0;
    const d = f.deferred;
    f.deferred = makeDeferred(); // a later retry gets a fresh promise
    d.reject(err);
    emitSoon();
    pump();
  }

  async function tableReady(t) {
    if (t.ready) return;
    await Promise.all(t.files.map((f) => (f.state === "ready" ? null : f.deferred.promise)));
    if (!t.viewPromise) {
      t.viewPromise = Promise.resolve()
        .then(() => onTableReady(t.name, t.files.map((f) => f.name)))
        .then(
          () => {
            t.ready = true;
          },
          (e) => {
            t.viewPromise = null; // allow a retry
            throw e;
          }
        );
    }
    await t.viewPromise;
  }

  // ── the queue ──────────────────────────────────────────────────────────────
  function classOf(f) {
    const c = classifyTable(f.table);
    if (c.shared) return CLASS_SHARED;
    if (c.gender === priority.gender && priority.buckets.has(c.bucket)) return CLASS_SELECTED;
    return CLASS_REST;
  }

  /** file → id of the NEWEST unfinished request that needs it. */
  function urgency() {
    const u = new Map();
    for (const r of requests) {
      for (const f of r.files) {
        if (f.state === "ready") continue;
        u.set(f, Math.max(u.get(f) || 0, r.id));
      }
    }
    return u;
  }

  /** The queue order, exported for the harness via loader.plan(). Urgent files
   * first — the newest Search first, then LARGEST first (the whole set finishes
   * soonest when the biggest file is not left running alone at the end); then
   * background: shared → selected gender/format → the rest, smallest-first. */
  function ordered(list, u) {
    return list.slice().sort((a, b) => {
      const ua = u.get(a) || 0;
      const ub = u.get(b) || 0;
      if (ua || ub) {
        if (!ua) return 1;
        if (!ub) return -1;
        if (ua !== ub) return ub - ua;
        return b.bytes - a.bytes || a.name.localeCompare(b.name);
      }
      return classOf(a) - classOf(b) || a.bytes - b.bytes || a.name.localeCompare(b.name);
    });
  }

  let pumping = false;
  let holdPump = false; // true while the device scan queues the missing files
  function pump() {
    if (pumping || holdPump) return;
    pumping = true;
    try {
      const u = urgency();
      const all = [...files.values()];
      const downloading = all.filter((f) => f.state === "downloading");
      let active = downloading.length;
      let activeUrgent = downloading.filter((f) => u.has(f)).length;
      const queued = ordered(all.filter((f) => f.state === "queued"), u);
      // Urgent files start at once, on their own budget of `concurrency`.
      for (const f of queued) {
        if (!u.has(f)) continue;
        if (activeUrgent >= concurrency) break;
        startDownload(f);
        activeUrgent++;
        active++;
      }
      const urgentPending = all.some((f) => u.has(f) && (f.state === "queued" || f.state === "downloading"));
      if (background === "on" && !urgentPending) {
        for (const f of queued) {
          if (u.has(f) || f.state !== "queued") continue;
          if (active >= concurrency) break;
          startDownload(f);
          active++;
        }
      }
    } finally {
      pumping = false;
    }
  }

  function startDownload(f) {
    f.state = "downloading";
    f.loaded = 0;
    emitSoon();
    download(f);
  }

  async function download(f) {
    try {
      let bytes = await fetchVerified(f);
      f.state = "registering"; // frees the download slot while it is written + registered
      emitSoon();
      pump();
      await storeAndRegister(f, bytes);
      bytes = null;
      markReady(f);
    } catch (e) {
      failFile(f, e);
    }
  }

  /** Browser HTTP-cache mode for a download. Files kept on the device skip the
   * HTTP cache entirely ("no-store") — the data files are served "immutable, 1
   * year", so the default mode would store every file a SECOND time (~85 MB
   * more on a phone). With no device store, the HTTP cache is the only thing
   * that spares a return visit the download, so it is kept ("default"); the
   * integrity retry then goes past it ("reload"). */
  function cacheModeFor(retry) {
    if (dir && deviceWritable && ioMode !== "memory") return "no-store";
    return retry ? "reload" : "default";
  }

  async function fetchVerified(f) {
    let reloadUsed = false;
    let networkTries = 0;
    for (;;) {
      let got;
      try {
        got = await fetchBytes(f, cacheModeFor(reloadUsed));
      } catch (e) {
        if (networkTries >= retryDelaysMs.length) {
          throw userError(
            `download of ${f.name} failed: ${e && e.message}`,
            `Could not download the data for this search (${f.name}). Check your internet connection and try again.`,
            { cause: e }
          );
        }
        await sleep(retryDelaysMs[networkTries++]);
        continue;
      }
      if (got.sizeOk) {
        const hex = await hash(got.bytes);
        if (hex == null) {
          if (!warnedNoHash) {
            warnedNoHash = true;
            log("this browser cannot verify file fingerprints — relying on byte sizes only");
          }
          return got.bytes;
        }
        if (hex === f.sha12) return got.bytes;
      }
      // The bytes do not match the catalogue: either a stale copy was served, or
      // the file changed on the server after this page read manifest_v2.json.
      // Retry ONCE past every cache; if it still does not match, stop — never
      // keep a file from a different data version than its sibling tiers.
      if (!reloadUsed) {
        reloadUsed = true;
        continue;
      }
      throw userError(
        `${f.name} does not match the data catalogue (expected ${f.sha12})`,
        "The cricket data was updated on the server while this page was open. Please reload the page to load the latest data.",
        { dataChanged: true }
      );
    }
  }

  async function fetchBytes(f, cacheMode) {
    const url = `${baseUrl}${f.name}?v=${f.sha12}`;
    const res = await fetchImpl(url, { cache: cacheMode });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "?"} for ${url}`);
    const out = new Uint8Array(f.bytes);
    let off = 0;
    f.loaded = 0;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (off + value.byteLength > out.length) {
          try {
            reader.cancel();
          } catch {
            /* ignore */
          }
          return { bytes: out, sizeOk: false };
        }
        out.set(value, off);
        off += value.byteLength;
        f.loaded = off;
        emitSoon();
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength !== out.length) return { bytes: out, sizeOk: false };
      out.set(buf);
      off = buf.byteLength;
      f.loaded = off;
    }
    return { bytes: out, sizeOk: off === out.length };
  }

  async function storeAndRegister(f, bytes) {
    if (dir && deviceWritable && ioMode !== "memory") {
      let handle = null;
      let file = null;
      try {
        await holdLock(f.deviceName);
        handle = await dir.getFileHandle(f.deviceName, { create: true });
        await writeBytes(handle, f.deviceName, bytes);
        file = await handle.getFile();
        if (file.size !== f.bytes) throw new Error(`short write (${file.size} of ${f.bytes} bytes)`);
      } catch (e) {
        file = null;
        if (isQuotaError(e)) {
          deviceWritable = false;
          log("device storage is full — keeping the remaining files in memory for this visit", e);
        } else {
          log(`could not keep ${f.name} on the device — keeping it in memory for this visit`, e);
        }
        if (handle) {
          try {
            await dir.removeEntry(f.deviceName);
          } catch {
            /* a partial file is caught by the size check next visit */
          }
        }
      }
      if (file) {
        // Kept on the device: DuckDB reads it from there (the in-memory bytes are
        // only the last-resort fallback and are dropped once this returns).
        await registerChain(f, deviceSources(handle, file, bytes));
        return;
      }
    }
    await registerChain(f, [async () => ({ kind: "buffer", bytes })]);
  }

  async function writeBytes(handle, deviceName, bytes) {
    if (typeof handle.createWritable === "function") {
      const w = await handle.createWritable(); // replaces the contents on close()
      try {
        await w.write(bytes);
        await w.close();
      } catch (e) {
        try {
          await w.abort();
        } catch {
          /* ignore */
        }
        throw e;
      }
      return;
    }
    if (syncWrite) {
      await syncWrite(deviceName, bytes);
      return;
    }
    throw new Error("this browser cannot write to device storage");
  }

  // ── public: waiting for data ───────────────────────────────────────────────
  /**
   * Wait until every file of `tableNames` is registered and each table's view
   * exists, pulling them to the FRONT of the queue. Returns null when they are
   * all ready already (the fast path — nothing to await), else a Promise.
   * `onProgress({loadedBytes, totalBytes, files, readyFiles})` fires (throttled)
   * while any of them still has to come over the network.
   */
  function ensureTables(tableNames, onProgress) {
    const names = [...new Set(tableNames || [])];
    const missing = names.filter((t) => !tables.has(t));
    if (missing.length) {
      return Promise.reject(
        userError(
          `manifest_v2.json lists no files for: ${missing.join(", ")}`,
          `The data catalogue is missing some files (${missing.join(", ")}). The data pipeline may not have finished publishing — please try again later.`
        )
      );
    }
    const list = names.map((t) => tables.get(t));
    if (list.every((t) => t.ready)) return null;
    const reqFiles = [...new Set(list.flatMap((t) => t.files))];
    const req = {
      id: ++requestSeq,
      files: reqFiles,
      readyAtStart: new Set(reqFiles.filter((f) => f.state === "ready")),
      onProgress: typeof onProgress === "function" ? onProgress : null,
      lastEmit: 0,
    };
    for (const f of reqFiles) if (f.state === "failed") queue(f);
    requests.add(req);
    pump();
    emitRequest(req, true);
    return Promise.all(list.map(tableReady)).then(
      () => {
        requests.delete(req);
        emitRequest(req, true);
        pump();
      },
      (e) => {
        requests.delete(req);
        pump();
        throw e;
      }
    );
  }

  function requestProgress(req) {
    let loadedBytes = 0;
    let totalBytes = 0;
    let readyFiles = 0;
    for (const f of req.files) {
      if (f.state === "ready") readyFiles++;
      if (req.readyAtStart.has(f) || !f.needsNetwork) continue;
      totalBytes += f.bytes;
      loadedBytes += f.state === "ready" || f.state === "registering" ? f.bytes : f.loaded;
    }
    return { loadedBytes, totalBytes, files: req.files.length, readyFiles };
  }

  function emitRequest(req, force) {
    if (!req.onProgress) return;
    const t = now();
    if (!force && t - req.lastEmit < PROGRESS_THROTTLE_MS) return;
    const p = requestProgress(req);
    if (p.totalBytes <= 0) return; // nothing to download (only local registration)
    req.lastEmit = t;
    try {
      req.onProgress(p);
    } catch (e) {
      log("progress callback failed", e);
    }
  }

  function snapshot() {
    const list = [...files.values()];
    return {
      storage,
      background,
      totalBytes: list.reduce((s, f) => s + f.bytes, 0),
      readyBytes: list.filter((f) => f.state === "ready").reduce((s, f) => s + f.bytes, 0),
      allReady: list.length > 0 && list.every((f) => f.state === "ready"),
      files: list.map((f) => ({
        name: f.name,
        table: f.table,
        tier: f.tier,
        bytes: f.bytes,
        state: f.state,
        loaded: f.loaded,
        registeredAs: f.registeredAs,
        error: f.error ? f.error.userMessage || f.error.message : null,
      })),
    };
  }

  function emitSoon() {
    for (const req of requests) emitRequest(req, false);
    if (emitTimer) return;
    emitTimer = schedule(() => {
      emitTimer = null;
      try {
        emit(snapshot());
      } catch (e) {
        log("download progress subscriber failed", e);
      }
    }, PROGRESS_THROTTLE_MS);
  }

  // ── public: priority + background control ─────────────────────────────────
  /** gender "m"|"f"|null, buckets iterable of "t20"|"odi"|"red". Cheap + idempotent. */
  function setPriority({ gender = null, buckets = [] } = {}) {
    const b = new Set(buckets);
    const sig = `${gender}|${[...b].sort().join(",")}`;
    if (sig === priority.sig) return;
    priority = { gender, buckets: b, sig };
    retryFailedInBackground();
    pump();
  }

  /** "on" (download everything in the background), "hold" (until the member
   * answers the mobile-data question) or "off" (declined: only what searches need). */
  function setBackground(mode) {
    if (mode !== "on" && mode !== "hold" && mode !== "off") return;
    background = mode;
    if (mode === "on") retryFailedInBackground();
    pump();
    emitSoon();
  }

  function retryFailedInBackground() {
    if (background !== "on") return;
    const t = now();
    for (const f of files.values()) {
      if (f.state === "failed" && t - f.failedAt >= BACKGROUND_RETRY_COOLDOWN_MS) queue(f);
    }
  }

  /** Bytes still to come over the network (files not yet on the device/in memory). */
  function remainingBytes() {
    let n = 0;
    for (const f of files.values()) {
      if (f.state === "ready" || f.state === "registering") continue;
      n += f.bytes - (f.state === "downloading" ? f.loaded : 0);
    }
    return n;
  }

  return {
    start,
    ensureTables,
    filesForTable,
    hasTable: (t) => tables.has(t),
    setPriority,
    setBackground,
    remainingBytes,
    snapshot,
    whenScanned: () => scanPromise || Promise.resolve(),
    whenCleanedUp: () => (scanPromise || Promise.resolve()).then(() => cleanupPromise),
    // Harness hooks (read-only views of the queue).
    plan: () => ordered([...files.values()].filter((f) => f.state === "queued"), urgency()).map((f) => f.name),
    fileState: (name) => (files.has(name) ? files.get(name).state : null),
  };
}

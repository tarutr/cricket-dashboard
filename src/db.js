// src/db.js
// The ONLY module that talks to DuckDB-WASM. Everything else (debug page, and
// later Compare Stats / Graph Builder) goes through initDB()/query()/getManifest().
//
// Flow: fetch manifest.json (cache-busted) -> load vendored duckdb-wasm ->
// instantiate AsyncDuckDB -> register each Parquet file's HTTP URL (cache-busted
// with the manifest's per-file content hash) -> create SQL views over them.

import { DATA_BASE_URL, PARQUET_FILES, VENDOR_DUCKDB } from "./config.js";

// View name -> parquet file name.
const VIEWS = {
  players: "players.parquet",
  matches: "matches.parquet",
  batting: "batting_innings.parquet",
  bowling: "bowling_innings.parquet",
  player_matches: "player_matches.parquet",
};

let initPromise = null;
let manifest = null;
let db = null; // AsyncDuckDB instance
let conn = null; // shared AsyncDuckDBConnection

function makeError(rawError, userMessage) {
  const err = rawError instanceof Error ? rawError : new Error(String(rawError));
  err.userMessage = userMessage;
  return err;
}

/**
 * Fetch and parse manifest.json from the data bucket. Cache-busted on every
 * call so we always see the latest pipeline run.
 */
async function fetchManifest() {
  const url = `${DATA_BASE_URL}manifest.json?t=${Date.now()}`;
  let res;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e) {
    throw makeError(
      e,
      `Could not reach the data server to fetch manifest.json. Check your internet connection, or the R2 bucket may be down/misconfigured (CORS?). (${url})`
    );
  }
  if (!res.ok) {
    throw makeError(
      new Error(`manifest.json HTTP ${res.status}`),
      `manifest.json responded with HTTP ${res.status}. The data bucket may be misconfigured or the file is missing. (${url})`
    );
  }
  try {
    return await res.json();
  } catch (e) {
    throw makeError(e, `manifest.json was not valid JSON. The pipeline may have written a corrupt file. (${url})`);
  }
}

/**
 * Load the vendored duckdb-wasm ES module, pick the best bundle (mvp vs eh),
 * spin up its worker, and instantiate an AsyncDuckDB instance.
 */
async function loadDuckDB(onProgress) {
  let duckdb;
  try {
    duckdb = await import(/* @vite-ignore */ `${VENDOR_DUCKDB}duckdb-browser.mjs`);
  } catch (e) {
    const isBareSpecifier = /resolve module specifier/i.test(e.message ?? "");
    const hint = isBareSpecifier
      ? ` duckdb-browser.mjs imports "apache-arrow" (which itself imports "tslib" and "flatbuffers") as bare specifiers — these need a browser <script type="importmap"> entry (or vendored alongside duckdb-wasm) since there is no bundler here.`
      : ` The vendored duckdb-wasm files are probably missing or the path is wrong — check vendor/duckdb-wasm/.`;
    throw makeError(e, `Could not load duckdb-browser.mjs from ${VENDOR_DUCKDB}.${hint}`);
  }

  const bundles = {
    mvp: {
      mainModule: `${VENDOR_DUCKDB}duckdb-mvp.wasm`,
      mainWorker: `${VENDOR_DUCKDB}duckdb-browser-mvp.worker.js`,
    },
    eh: {
      mainModule: `${VENDOR_DUCKDB}duckdb-eh.wasm`,
      mainWorker: `${VENDOR_DUCKDB}duckdb-browser-eh.worker.js`,
    },
  };

  let bundle;
  try {
    bundle = await duckdb.selectBundle(bundles);
  } catch (e) {
    throw makeError(
      e,
      `duckdb-wasm could not select a WASM bundle (mvp/eh) for this browser. This browser may be unsupported, or the vendored .wasm files are missing.`
    );
  }

  let worker;
  let instance;
  try {
    // Same-origin vendored worker: construct directly. (duckdb.createWorker's
    // blob-URL wrapper is for cross-origin CDNs and hangs in this setup.)
    worker = new Worker(bundle.mainWorker);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel ? duckdb.LogLevel.WARNING : undefined);
    instance = new duckdb.AsyncDuckDB(logger, worker);
    await instance.instantiate(bundle.mainModule, bundle.pthreadWorker, (progress) => {
      if (onProgress) onProgress({ stage: "instantiate", progress });
    });
  } catch (e) {
    throw makeError(
      e,
      `Failed to instantiate DuckDB-WASM (worker: ${bundle.mainWorker}, module: ${bundle.mainModule}). The .wasm/.worker.js files may be missing, corrupt, or blocked by the browser's security policy.`
    );
  }

  return { duckdb, db: instance };
}

/**
 * Register the Parquet files (HTTP protocol, cache-busted with the manifest's
 * content hash) and create the four SQL views the rest of the app queries.
 */
async function registerData(duckdbMod, dbInstance, connection, manifestData, onProgress) {
  for (const name of PARQUET_FILES) {
    const fileInfo = manifestData?.files?.[name];
    const version = fileInfo?.sha256_12 ?? Date.now();
    const url = `${DATA_BASE_URL}${name}?v=${version}`;
    if (onProgress) onProgress({ stage: "register", file: name });
    try {
      await dbInstance.registerFileURL(name, url, duckdbMod.DuckDBDataProtocol.HTTP, false);
    } catch (e) {
      throw makeError(
        e,
        `Could not register ${name} for querying. The file may be missing from the data bucket, or CORS is not configured to allow this site's origin. (${url})`
      );
    }
  }

  for (const [viewName, fileName] of Object.entries(VIEWS)) {
    try {
      await connection.query(
        `CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_parquet('${fileName}')`
      );
    } catch (e) {
      throw makeError(
        e,
        `Could not create the "${viewName}" view from ${fileName}. The Parquet file may be corrupt or unreadable by DuckDB-WASM.`
      );
    }
  }
}

async function doInit(onProgress) {
  if (onProgress) onProgress({ stage: "manifest" });
  manifest = await fetchManifest();

  if (onProgress) onProgress({ stage: "loading-duckdb" });
  const { duckdb, db: dbInstance } = await loadDuckDB(onProgress);
  db = dbInstance;

  if (onProgress) onProgress({ stage: "connecting" });
  try {
    conn = await db.connect();
  } catch (e) {
    throw makeError(e, "Could not open a connection to the in-browser DuckDB instance.");
  }

  if (onProgress) onProgress({ stage: "registering-data" });
  await registerData(duckdb, db, conn, manifest, onProgress);

  if (onProgress) onProgress({ stage: "ready" });
  return { manifest };
}

/**
 * Idempotent initializer. Safe to call multiple times/concurrently — every
 * caller gets the same promise/result. If init fails, the failed promise is
 * cleared so a subsequent call (e.g. after the user clicks Retry) starts over.
 */
export async function initDB(onProgress) {
  if (!initPromise) {
    initPromise = doInit(onProgress).catch((e) => {
      initPromise = null; // allow retry
      throw e;
    });
  }
  return initPromise;
}

/**
 * Run a SQL query against the shared connection. Returns plain JS objects
 * (Arrow -> JSON, with safely-integral BigInts coerced to Number) plus wall
 * clock timing in milliseconds.
 */
export async function query(sql) {
  if (!conn) {
    throw makeError(
      new Error("query() called before initDB() completed"),
      "The database is not ready yet. Please wait for initialization to finish and try again."
    );
  }
  const start = performance.now();
  let table;
  try {
    table = await conn.query(sql);
  } catch (e) {
    throw makeError(e, `Query failed: ${e.message ?? "unknown error"}`);
  }
  const ms = performance.now() - start;

  const rows = table.toArray().map((row) => {
    const obj = row.toJSON ? row.toJSON() : { ...row };
    for (const key of Object.keys(obj)) {
      obj[key] = normalizeValue(obj[key]);
    }
    return obj;
  });

  return { rows, ms };
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function normalizeValue(value) {
  if (typeof value === "bigint") {
    if (value >= -BigInt(MAX_SAFE) && value <= BigInt(MAX_SAFE)) {
      return Number(value);
    }
    return value.toString();
  }
  return value;
}

/** Returns the parsed manifest.json (or null if init hasn't completed yet). */
export function getManifest() {
  return manifest;
}

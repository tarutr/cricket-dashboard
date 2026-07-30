// src/db.js
// The ONLY module that talks to DuckDB-WASM. Everything else (debug page, and
// later Compare Stats / Graph Builder) goes through initDB()/query()/getManifest().
//
// Flow: fetch manifest.json (cache-busted) -> load vendored duckdb-wasm ->
// instantiate AsyncDuckDB -> register each Parquet file's HTTP URL (cache-busted
// with the manifest's per-file content hash) -> create SQL views over them.

import { DATA_BASE_URL, PARQUET_FILES, VENDOR_DUCKDB, ballEngineEnabled } from "./config.js";
import { buildInningsViewSql, DELIVERY_FILES } from "./ballEngine.js";

// View name -> parquet file name.
const VIEWS = {
  players: "players.parquet",
  matches: "matches.parquet",
  batting: "batting_innings.parquet",
  bowling: "bowling_innings.parquet",
  player_matches: "player_matches.parquet",
  // D4: one row per matched player_id (profile filters); matchup grains for Pieces 4–5.
  profiles: "player_profiles.parquet",
  // Fielding rebuild: event-grain fielding (one row per wicket-credit).
  fielding: "fielding_events.parquet",
  matchup_batting: "matchup_batting.parquet",
  matchup_bowling: "matchup_bowling.parquet",
};

// ── Ball engine (Wave 2a, owner decision 67) ────────────────────────────────
// When ballEngineEnabled() (the ?engine=ball flag) is on, the `batting` /
// `bowling` views are RECONSTRUCTED from the six delivery files by
// src/ballEngine.js instead of reading batting_innings.parquet /
// bowling_innings.parquet. matchup_batting / matchup_bowling STAY on the innings
// parquet (that swap is Wave 2b). Every downstream query is byte-identical
// because the reconstruction is proven cell-for-cell identical to the export.
//
// The reconstruction re-aggregates raw balls, so — unlike the pre-aggregated
// innings parquet — it is only usable when scoped to the gender+format file(s)
// the query actually asks for (measured: all-6 = 21s vs one file = ~3s warm; the
// scope filter does not prune through the ANY_VALUE aggregation). So the two
// views are (re)created SCOPED — file subset + a pushed-down core-scope predicate
// derived from the query's own literals (scopeForQuery) — lazily, only when that
// scope signature changes.
const engineViews = ["batting", "bowling"];
let engineOn = false; // set in registerData from ballEngineEnabled()
let engineScopeKey = null; // signature of the scope the views are currently built for

/** Re-create the `batting` / `bowling` views from the ball engine, reading only
 * `files` and pushing `scopePredicate` into the base ball CTE. CREATE OR REPLACE
 * VIEW is metadata-only — the heavy per-ball aggregation runs when a query
 * executes against the view, not here — so re-scoping is cheap. */
async function createEngineViews(connection, files, scopePredicate) {
  for (const discipline of engineViews) {
    try {
      await connection.query(
        `CREATE OR REPLACE VIEW ${discipline} AS ${buildInningsViewSql(discipline, { files, scopePredicate })}`
      );
    } catch (e) {
      throw makeError(
        e,
        `Could not create the ball-engine "${discipline}" view. The delivery Parquet files may be missing/unreadable, or the ballEngine SQL is malformed.`
      );
    }
  }
  engineScopeKey = `${files.join("|")}::${scopePredicate}`;
}

/**
 * Derive, from a query's OWN scope literals, (a) which delivery files the
 * ball-engine views should read and (b) the core-scope predicate to push into
 * the base ball CTE. Exported so the offline byte-identical harness scopes the
 * views EXACTLY as the runtime does — the two can never diverge.
 *
 * FILES: UNION semantics over every `gender = '…'` / `match_type IN (…)` literal
 * → always a SUPERSET of the files that can hold in-scope rows (never under-reads);
 * any uncertainty (missing gender, unknown/absent match_type) widens to all files
 * on that axis. Each delivery file is single-gender / single-format-bucket and
 * every match lives entirely in one file, so reading only these files + the
 * query's own WHERE yields exactly the rows reading all six would.
 *
 * SCOPE PREDICATE: the gender / match_type / team_type / match_date clauses lifted
 * VERBATIM from the query (all four are raw ball columns, constant within a
 * (match_id, innings_number)). Pushing them into the base filters balls to only
 * in-scope innings BEFORE aggregation (the memory/speed lever + row-group/file
 * pruning) and is byte-identical: it can only ever drop WHOLE out-of-scope
 * innings, which the caller's outer WHERE discards anyway (see ballEngine
 * baseWhere). Lifting the query's OWN clauses guarantees the base is never
 * narrower than the innings the outer query keeps. Clauses that decide WHICH
 * players/teams (team, opposition, position, event, venue, profile, match
 * context) are deliberately NOT lifted — the view must stay at core-scope grain
 * so an in-query sub-use like the R. Pos. CTE (modal position over the core scope)
 * still sees every core-scope innings.
 */
export function scopeForQuery(sql) {
  // --- files (superset-safe) ---
  const genders = new Set();
  for (const m of sql.matchAll(/gender\s*=\s*'(male|female)'/g)) {
    genders.add(m[1] === "male" ? "m" : "f");
  }
  if (genders.size === 0) {
    genders.add("m");
    genders.add("f");
  }
  const buckets = new Set();
  let sawMatchType = false;
  let sawUnknown = false;
  for (const m of sql.matchAll(/match_type\s+IN\s*\(([^)]*)\)/gi)) {
    sawMatchType = true;
    for (const t of m[1].matchAll(/'([^']*)'/g)) {
      const ty = t[1];
      if (ty === "T20" || ty === "IT20") buckets.add("t20");
      else if (ty === "ODI" || ty === "ODM") buckets.add("odi");
      else if (ty === "Test" || ty === "MDM") buckets.add("red");
      else sawUnknown = true;
    }
  }
  if (!sawMatchType || sawUnknown || buckets.size === 0) {
    buckets.add("t20");
    buckets.add("odi");
    buckets.add("red");
  }
  const files = [];
  for (const g of genders) for (const b of buckets) files.push(`deliveries_${g}_${b}.parquet`);
  files.sort();

  // --- scope predicate (verbatim clauses on raw ball columns) ---
  const parts = [];
  const g = sql.match(/gender\s*=\s*'(?:male|female)'/);
  if (g) parts.push(g[0]);
  const mt = sql.match(/match_type\s+IN\s*\([^)]*\)/i);
  if (mt) parts.push(mt[0]);
  const tt = sql.match(/team_type\s*=\s*'(?:international|club)'/);
  if (tt) parts.push(tt[0]);
  const dlo = sql.match(/match_date\s*>=\s*DATE\s*'[0-9-]+'/i);
  if (dlo) parts.push(dlo[0]);
  const dhi = sql.match(/match_date\s*<\s*DATE\s*'[0-9-]+'/i);
  if (dhi) parts.push(dhi[0]);
  const scopePredicate = parts.join(" AND ");

  return { files, scopePredicate };
}

/** Before a ball-engine query runs, ensure `batting`/`bowling` are scoped to it.
 * No-op unless the ball engine is on AND the SQL actually references one of the
 * two engine views (`\bbatting\b` / `\bbowling\b` — deliberately NOT matching
 * batting_team / bowling_group / matchup_batting, where the token is glued to a
 * word char). Only re-creates when the scope signature changed, so repeated
 * same-scope searches pay nothing. */
async function ensureEngineScope(sql) {
  if (!engineOn) return;
  if (!/\b(?:batting|bowling)\b/.test(sql)) return;
  const { files, scopePredicate } = scopeForQuery(sql);
  const key = `${files.join("|")}::${scopePredicate}`;
  if (key === engineScopeKey) return;
  await createEngineViews(conn, files, scopePredicate);
}

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
  // Batch 5b C5b: registerFileURL calls are independent (each just tells the
  // WASM runtime a virtual filename maps to an HTTP URL — no shared state
  // between files), so run all 7 in parallel instead of one-at-a-time.
  // Per-file try/catch is kept so a failure still names the specific file
  // and URL in the human-readable error (same makeError path as before);
  // Promise.all rejects with the first one, same net effect as the old
  // sequential loop's first-failure-wins behavior.
  if (onProgress) onProgress({ stage: "register" });
  await Promise.all(
    PARQUET_FILES.map(async (name) => {
      const fileInfo = manifestData?.files?.[name];
      const version = fileInfo?.sha256_12 ?? Date.now();
      const url = `${DATA_BASE_URL}${name}?v=${version}`;
      try {
        await dbInstance.registerFileURL(name, url, duckdbMod.DuckDBDataProtocol.HTTP, false);
      } catch (e) {
        throw makeError(
          e,
          `Could not register ${name} for querying. The file may be missing from the data bucket, or CORS is not configured to allow this site's origin. (${url})`
        );
      }
    })
  );

  // CREATE VIEW statements only depend on their OWN file already being
  // registered (done above) — not on each other — and this duckdb-wasm setup
  // handles concurrent queries on one connection fine (verified: concurrent
  // CREATE VIEW calls against the shared connection all completed correctly
  // during manual testing), so these also run in parallel.
  //
  // Ball engine (Wave 2a): when the flag is on, `batting`/`bowling` are created
  // separately by createEngineViews (from the delivery files) — skip them here.
  // matchup_batting / matchup_bowling and every other view are unchanged.
  engineOn = ballEngineEnabled();
  await Promise.all(
    Object.entries(VIEWS).map(async ([viewName, fileName]) => {
      if (engineOn && engineViews.includes(viewName)) return; // ball engine owns these
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
    })
  );

  // Seed the ball-engine views over ALL six files, unscoped (a correct default so
  // the views EXIST). Metadata-only; ensureEngineScope narrows BOTH the file set
  // and the pushed-down scope predicate before any heavy aggregation runs, so the
  // unscoped all-six definition is never actually executed.
  if (engineOn) {
    // eslint-disable-next-line no-console
    console.info("[cricdb] ball engine ON (?engine=ball) — batting/bowling views reconstructed from delivery files");
    await createEngineViews(connection, DELIVERY_FILES.slice(), "");
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
  // Ball engine (Wave 2a): scope the batting/bowling views to this query's
  // gender+format before it runs. No-op when the flag is off or the query does
  // not touch those views.
  await ensureEngineScope(sql);
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
  // DuckDB LIST/ARRAY columns arrive as Arrow Vectors (iterable, but missing
  // plain-array methods like .filter/.map/.slice) — used by C4's merged
  // profile-options query (list(DISTINCT …)). Flatten to a real array so
  // callers can treat it like any other JS array.
  if (value !== null && typeof value === "object" && typeof value.toArray === "function") {
    return Array.from(value.toArray(), normalizeValue);
  }
  return value;
}

/** Returns the parsed manifest.json (or null if init hasn't completed yet). */
export function getManifest() {
  return manifest;
}

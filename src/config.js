// Central configuration for the browser data layer.
// No secrets here — the R2 bucket is public-read by design (see SPEC.md §4.4).

export const DATA_BASE_URL = "https://data.the-cordon.com/explorer/";

export const PARQUET_FILES = [
  "players.parquet",
  "matches.parquet",
  "batting_innings.parquet",
  "bowling_innings.parquet",
  "player_matches.parquet",
  // D4: profile-powered filters (used now) + matchup aggregates (wired in Pieces 4–5).
  "player_profiles.parquet",
  // Fielding rebuild: event-grain fielding (one row per wicket-credit) — feeds
  // the Catches/Stumpings/Run-outs/Dismissals-Effected metrics via the per-fielder
  // pre-aggregated subquery in table.js buildQuery.
  "fielding_events.parquet",
  "matchup_batting.parquet",
  "matchup_bowling.parquet",
  // Ball-grain rebuild (Wave 2a, owner decision 67): the six delivery ("ball
  // layer") files, one per gender × format bucket. Registered UNCONDITIONALLY so
  // the ball engine (behind the ?engine=ball flag) can read them; when the flag
  // is OFF they are registered but never queried, so this is a no-op for today's
  // behaviour (registerFileURL only maps a virtual name → URL; nothing is fetched
  // until a query reads the file). In production they load once the pipeline ships
  // them; until then the flag-OFF site is unaffected and flag-ON needs local data.
  "deliveries_m_t20.parquet",
  "deliveries_m_odi.parquet",
  "deliveries_m_red.parquet",
  "deliveries_f_t20.parquet",
  "deliveries_f_odi.parquet",
  "deliveries_f_red.parquet",
];

export const VENDOR_DUCKDB = "/vendor/duckdb-wasm/";

// ── Speed build W2: the ball-engine site's data (manifest_v2.json) ────────────
// With the ball engine on, db.js reads manifest_v2.json + options_v2.json and
// keeps every tier file on the member's device (src/dataLoader.js). Same bucket
// as DATA_BASE_URL unless a DEV switch below points elsewhere.

/** True only on a local development host. Every DEV switch below is ignored
 * anywhere else, so no production visitor can ever trigger one. */
function onLocalDevHost() {
  try {
    if (typeof location === "undefined") return false;
    const h = location.hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  } catch {
    return false;
  }
}

function devParam(name) {
  if (!onLocalDevHost()) return null;
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

/** DEV ONLY: W1's local export (tier files + manifest_v2.json + options_v2.json),
 * served by the local dev server, for testing before anything is uploaded. */
export const LOCAL_DATA_BASE_URL = "/.orchestrator/_w1_tmp/out/";

/** DEV ONLY: `?data=local` (localhost only) → read W1's local export. */
export function isLocalDataMode() {
  return devParam("data") === "local";
}

/** Where the ball-engine loader reads manifest_v2.json and the tier files. */
export function dataBaseUrlV2() {
  return isLocalDataMode() ? LOCAL_DATA_BASE_URL : DATA_BASE_URL;
}

/** DEV ONLY: `?io=fsaccess|memory` (localhost only) — how DuckDB reads the kept
 * files, for timing comparisons. Default "filereader" (see src/dataLoader.js). */
export function devIoMode() {
  const v = devParam("io");
  return v === "fsaccess" || v === "memory" ? v : "filereader";
}

/** DEV ONLY: `?net=cellular` (localhost only) — behave as if on Android mobile
 * data, so the "download all data?" question can be tested on a desktop. */
export function devForceMobileData() {
  return devParam("net") === "cellular";
}

// Owner ruling 2026-09-28: graphs are switched OFF the public site pending a
// UX rework — flip this back to true to re-enable the Graphs tab, the
// "Player Graphs" popup button, and Chart.js loading, all in one place.
export const GRAPHS_ENABLED = false;

// Ball-grain rebuild (Wave 2a, owner decision 67): the `?engine=ball` URL param
// switches the `batting`/`bowling` views from the pre-aggregated innings parquet
// to a live reconstruction from the six delivery files (src/ballEngine.js, wired
// in db.js). Speed build W2: the flag also switches the DATA LOADER — manifest_v2
// tier files kept on the device (src/dataLoader.js) instead of ranged HTTP reads.
// DEFAULT OFF — with no param (or any other value) the site behaves
// exactly as today. Evaluated lazily (a function, not a module-load constant) and
// guarded for non-browser contexts so importing this module under node never
// throws on a missing `location`.
export function ballEngineEnabled() {
  try {
    if (typeof location === "undefined" || typeof URLSearchParams === "undefined") return false;
    return new URLSearchParams(location.search).get("engine") === "ball";
  } catch {
    return false;
  }
}

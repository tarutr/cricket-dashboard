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

// Ball-grain rebuild (Wave 2a, owner decision 67): the `?engine=ball` URL param
// switches the `batting`/`bowling` views from the pre-aggregated innings parquet
// to a live reconstruction from the six delivery files (src/ballEngine.js, wired
// in db.js). DEFAULT OFF — with no param (or any other value) the site behaves
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

// Central configuration for the browser data layer.
// No secrets here — the R2 bucket is public-read by design (see SPEC.md §4.4).

export const DATA_BASE_URL = "https://pub-36370b9c2d3a4ff7aa805327329dc811.r2.dev/explorer/";

export const PARQUET_FILES = [
  "players.parquet",
  "matches.parquet",
  "batting_innings.parquet",
  "bowling_innings.parquet",
];

export const VENDOR_DUCKDB = "/vendor/duckdb-wasm/";

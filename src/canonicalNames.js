// src/canonicalNames.js
//
// Event + stage NAME NORMALIZATION (backlog #5 part-1, owner-vetted). Many raw
// `event_name` / `event_stage` spellings in the data denote the SAME thing —
// sponsor renames ("LV= County Championship" → "Specsavers …" → "County
// Championship"), historical rebrands ("ICC World Twenty20" → "World T20" →
// "ICC Men's T20 World Cup"), and casing/hyphen/whitespace variants of a stage
// ("Semi Final" / "Semi-Final" / "Semi-final"). This module folds each such
// family to ONE canonical label the pickers display, and — crucially — lets a
// selected canonical match ALL its raw variants at query time, so results are
// MORE complete, not fewer.
//
// This is DISPLAY-COLLAPSE ONLY: the data is never rewritten. The pickers store
// canonical labels in state; the query builders (filters.js buildScopeClauses /
// buildMatchContextClauses) expand a selected canonical back to its raw alias
// set for the `event_name IN (...)` / `event_stage IN (...)` list. Anything not
// listed here maps to ITSELF (identity) — including the two multi-region
// qualifier oddballs the owner ruled stay standalone — with the typography rule
// applied so unlisted names still normalise curly apostrophes + stray
// whitespace.
//
// SOURCE OF TRUTH: .orchestrator/event_canonical_map.json (owner-vetted; 21
// event canonicals fold 87 raw names, 5 stage canonicals fold 12 spellings;
// validated: every alias exists in the data, none double-assigned). The app
// cannot read .orchestrator at runtime, so the map is embedded below VERBATIM
// (generated from that JSON — including the two curly-apostrophe U+2019 aliases,
// preserved byte-exact so they still match the raw DB values). If the JSON ever
// changes, regenerate these two consts from it.

// canonical label -> raw alias spellings (EXACT DB strings — do NOT
// typography-normalise these; two of them intentionally carry a curly U+2019).
const EVENT_MERGES = {
  ["ICC Men's Cricket World Cup"]: [
    "ICC World Cup",
    "ICC Cricket World Cup",
    "World Cup",
  ],
  ["ICC Men's T20 World Cup"]: [
    "ICC World Twenty20",
    "World T20",
    "ICC Men's T20 World Cup",
  ],
  ["ICC Women's T20 World Cup"]: [
    "ICC Women's World Twenty20",
    "Women's World T20",
    "ICC Women's T20 World Cup",
  ],
  ["County Championship"]: [
    "LV= County Championship",
    "Specsavers County Championship",
    "County Championship",
  ],
  ["Vitality Blast"]: [
    "NatWest T20 Blast",
    "Vitality Blast",
    "Vitality Blast Men",
  ],
  ["One-Day Cup"]: [
    "Royal London One-Day Cup",
    "One-Day Cup",
  ],
  ["CSA T20 Challenge"]: [
    "MiWAY T20 Challenge",
    "Ram Slam T20 Challenge",
    "CSA T20 Challenge",
  ],
  ["ICC Men's Cricket World Cup Qualifier"]: [
    "ICC Cricket World Cup Qualifier (ICC Trophy)",
    "ICC World Cup Qualifiers",
    "ICC Cricket World Cup Qualifier Play-off",
    "ICC Cricket World Cup Qualifier",
  ],
  ["ICC Men's T20 World Cup — Africa Qualifier"]: [
    "ICC World Twenty20 Africa Region Qualifier B",
    "ICC Men's T20 World Cup Sub Regional Africa Qualifier Group C",
    "ICC Men's T20 World Cup Sub Regional Africa Qualifier",
    "ICC Men's T20 World Cup Sub Regional Africa Qualifier Group A & B",
    "ICC World Twenty20 Africa Region Qualifier C",
    "ICC World Twenty20 Africa Region Qualifier A",
    "ICC Men's T20 World Cup Africa Region Final",
    "ICC Men's T20 World Cup Africa Region Qualifier",
    "ICC Men's T20 World Cup Africa Sub Regional Qualifier B",
  ],
  ["ICC Men's T20 World Cup — Americas Qualifier"]: [
    "ICC World Twenty20 Americas Sub Regional Qualifier A",
    "ICC Men's T20 World Cup Americas Region Qualifier",
    "ICC Men's T20 World Cup Sub Regional Americas Qualifier B",
    "ICC Men's T20 World Cup Sub Regional Americas Qualifier",
    "ICC Men's T20 World Cup Americas Region Final",
  ],
  ["ICC Women's T20 World Cup Qualifier"]: [
    "ICC Women's T20 World Cup Qualifier",
    "ICC Women's World Twenty20 Qualifier",
    "ICC Women's T20 Qualifier",
    "Women's T20 World Cup Qualifier",
  ],
  ["ICC Men's T20 World Cup — Europe Qualifier"]: [
    "ICC Men's T20 World Cup Europe Region Qualifier",
    "ICC Men's T20 World Cup Sub Regional Europe Qualifier Group C",
    "ICC Men's T20 World Cup Sub Regional Europe Qualifier A",
    "ICC World Twenty20 Europe Region Qualifier A",
    "ICC World Twenty20 Europe Region Qualifier C",
    "ICC Men's T20 World Cup Europe Region Final",
    "ICC Men's T20 World Cup Sub Regional Europe Qualifier",
    "ICC World Twenty20 Europe Region Qualifier B",
  ],
  ["ICC Men's T20 World Cup — East Asia-Pacific Qualifier"]: [
    "ICC Men's T20 World Cup East Asia-Pacific Region Qualifier B",
    "ICC World Twenty20 East Asia-Pacific Region Qualifier A",
    "ICC Men's T20 World Cup East Asia-Pacific Region Qualifier A",
    "ICC World Twenty20 East Asia-Pacific Region Qualifier B",
    "ICC World Twenty20 East Asia-Pacific Region Final",
    "ICC Men's T20 World Cup East Asia-Pacific Qualifier",
  ],
  ["ICC Women's T20 World Cup — Africa Qualifier"]: [
    "ICC Women's World Twenty20 Qualifying Series Africa Region",
    "ICC Women's T20 World Cup Africa Region Qualifier",
    "ICC Women's T20 World Cup Africa Region Division Two Qualifier",
    "ICC Women's T20 World Cup Africa Region Division One Qualifier",
  ],
  ["ICC Women's T20 World Cup — East Asia-Pacific Qualifier"]: [
    "ICC Women's T20 World Cup East Asia-Pacific Region Qualifier",
    "ICC Women's World Twenty20 Qualifying Series East Asia-Pacific Region",
    "ICC Women's T20 World Cup East Asia Pacific Qualifier",
  ],
  ["ICC Women's Cricket World Cup Qualifier"]: [
    "ICC Women's World Cup Qualifying Series",
    "ICC Women's World Cup Qualifier",
    "ICC Women's World Cup Qualifying Series Europe Region",
    "ICC Women's Cricket World Cup Qualifier",
  ],
  ["ICC Women's T20 World Cup — Asia Qualifier"]: [
    "ICC Women's T20 World Cup Asia Region Qualifier",
    "ICC Women's World Twenty20 Qualifying Series Asia Region",
  ],
  ["ICC Men's T20 World Cup Qualifier"]: [
    "ICC Men's T20 World Cup Qualifier A",
    "ICC Men's T20 World Cup Qualifier",
    "ICC Men’s T20 World Cup Qualifier A",
    "ICC World Twenty20 Qualifier",
  ],
  ["ICC Men's T20 World Cup — Asia Qualifier"]: [
    "ICC Men's T20 World Cup Sub Regional Asia Qualifier A",
    "ICC Men’s T20 World Cup Asia Qualifier Final",
    "ICC Men's T20 World Cup Asia Qualifier Final",
    "ICC Men's T20 World Cup Asia Qualifier A",
    "ICC Men's T20 World Cup Asia Qualifier B",
    "ICC World Twenty20 Asia Region Qualifier A",
    "ICC World Twenty20 Asia Region Qualifier B",
    "ICC Men's T20 World Cup Asia A Qualifier",
    "ICC Men's T20 World Cup Asia B Qualifier",
    "ICC Men's T20 World Cup Asia Region Final",
  ],
  ["ICC Women's T20 World Cup — Europe Qualifier"]: [
    "ICC Women's T20 World Cup Europe Division 1 Qualifier",
    "ICC Women's T20 World Cup Europe Division 2 Qualifier",
    "ICC Women's T20 World Cup Europe Region Qualifier",
  ],
  ["ICC Women's T20 World Cup — Americas Qualifier"]: [
    "ICC Women's T20 World Cup Americas Region Qualifier",
  ],
};

// canonical stage label -> raw spellings (EXACT DB strings). All merged
// spellings are knockout stages, so folding them changes no classification.
const STAGE_MERGES = {
  ["Semi-Final"]: [
    "Semi Final",
    "Semi-Final",
    "Semi-final",
  ],
  ["Quarter-Final"]: [
    "Quarter Final",
    "Quarter-Final",
    "Quarter-final",
  ],
  ["3rd Place Play-Off"]: [
    "3rd Place Play-Off",
    "3rd Place Play-off",
  ],
  ["Play-Off"]: [
    "Play-off",
    "Play-Off",
  ],
  ["Preliminary Quarter Final"]: [
    "Preliminary Quarter Final",
    "Preliminary quarter-final",
  ],
};

/**
 * The owner's typography_rule: normalise a curly apostrophe (U+2019) to a
 * straight one and collapse any run of whitespace to a single space, trimmed.
 * Applied as the FALLBACK inside the canonicalisers so an UNLISTED name still
 * comes out clean. NOTE the alias values above are NOT passed through this — a
 * couple of them intentionally carry a curly apostrophe because that is exactly
 * how they appear in the raw data, and the alias set must match the data
 * byte-for-byte.
 */
export function typographyNormalize(raw) {
  if (raw == null) return raw;
  return String(raw).replace(/’/g, "'").replace(/\s+/g, " ").trim();
}

/** Build both directions once at module load. `aliasToCanon` keys are the EXACT
 * raw alias strings; a second normalised-key map is a robustness net consulted
 * only on an exact miss (so a whitespace/apostrophe near-miss on a listed alias
 * still resolves) — real DB aliases always hit the exact map first. */
function buildIndex(merges) {
  const aliasToCanon = new Map(); // exact raw alias -> canonical
  const aliasToCanonNorm = new Map(); // typography-normalised alias -> canonical
  for (const canon of Object.keys(merges)) {
    for (const alias of merges[canon]) {
      aliasToCanon.set(alias, canon);
      const n = typographyNormalize(alias);
      if (!aliasToCanonNorm.has(n)) aliasToCanonNorm.set(n, canon);
    }
  }
  return { aliasToCanon, aliasToCanonNorm };
}

const EVENT_INDEX = buildIndex(EVENT_MERGES);
const STAGE_INDEX = buildIndex(STAGE_MERGES);

function canonicalize(raw, index) {
  if (raw == null) return raw;
  const exact = index.aliasToCanon.get(raw);
  if (exact) return exact;
  const norm = typographyNormalize(raw);
  const viaNorm = index.aliasToCanonNorm.get(norm);
  if (viaNorm) return viaNorm;
  return norm; // unlisted -> identity, typography-normalised
}

function aliasesFor(canonical, merges) {
  if (canonical == null) return [];
  const arr = merges[canonical];
  if (!arr) return [canonical]; // unlisted -> matches only itself
  // SYMMETRIC EXPANSION (round-trip fix). canonicalize() folds a raw value via
  // the exact alias map OR a typography-normalised fallback (curly->straight
  // apostrophe, collapsed whitespace); this reverse expansion must therefore
  // ALSO cover the normalised form of every listed alias — otherwise a future
  // typography variant of a KNOWN alias would DISPLAY under this canonical yet
  // be DROPPED from the event_name/event_stage IN(...) filter (a silent
  // under-count). Emit each literal alias FIRST in its original order, then any
  // normalised form not already present. On ALL CURRENT data every alias's
  // normalised form is already itself a literal alias (the two curly-apostrophe
  // aliases carry their straight-apostrophe twin explicitly), so nothing new is
  // appended and the IN-list is byte-identical; this only hardens against
  // future spellings. (The unlisted/identity case above can't be made symmetric
  // — there is no reverse map for an arbitrary raw value — so the round-trip
  // guard is the honest safety net there; see FIX 3(b).)
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };
  for (const alias of arr) push(alias); // literals first, original order
  for (const alias of arr) push(typographyNormalize(alias)); // then any new normalised variant
  return out;
}

/** Canonical display label for a raw event_name (or the raw, typography-
 * normalised, when it isn't one of the listed aliases). */
export function canonicalEvent(raw) {
  return canonicalize(raw, EVENT_INDEX);
}

/** The raw event_name spellings a selected canonical must match at query time
 * (its full alias set), or `[canonical]` when the label isn't a canonical (an
 * identity/standalone event — matches only its own raw name). */
export function eventAliases(canonical) {
  return aliasesFor(canonical, EVENT_MERGES);
}

/** Canonical display label for a raw event_stage (or the raw, typography-
 * normalised, when unlisted). */
export function canonicalStage(raw) {
  return canonicalize(raw, STAGE_INDEX);
}

/** The raw event_stage spellings a selected canonical stage must match, or
 * `[canonical]` when unlisted (identity). */
export function stageAliases(canonical) {
  return aliasesFor(canonical, STAGE_MERGES);
}

// src/paletteGroups.js
//
// The "+ Add condition" palette's 7-group TAXONOMY — extracted out of
// src/drawer.js's mountFilterDrawer closure (Wave A · T-F3, see
// .orchestrator/popup-tab2-build-plan.md, the "Palette" line in "Key seams")
// so a LATER wave can mount the same generic palette component
// (src/addPalette.js — already store-independent, unmodified here) a second
// time, in the player pop-up's Filters tab, with a REDUCED filter set —
// without forking or duplicating this ~260-line taxonomy.
//
// This module owns ONLY the group/leaf/family TREE-BUILDING logic. It never
// mutates state and never touches buildQuery/conditionToHaving/advancedToHaving
// — every leaf's `run()` closure calls back into whatever the CALLER supplied
// as `pickSingleton` / `pickMetric` (drawer.js's, wired to its own store/DOM
// today), so this extraction changes nothing about what a click does or what
// number a query returns (numbers sacred, CLAUDE.md Rule 1).
//
// ── API ──────────────────────────────────────────────────────────────────────
// createPaletteGroupsBuilder(deps) → buildPaletteGroups(s, gi, { surface } = {})
//   deps:
//     isPresent(type, s)     — the singleton-row presence predicate (a
//                               SINGLETON_TYPES entry + state → bool); used only
//                               to DISABLE a leaf/family whose row is already
//                               added, never to hide it from the offered list.
//     SINGLETON_TYPES        — the singleton condition-type array (for the
//                               presentSingles lookup above).
//     pickSingleton(key, preselect?) — reveal/pre-fill a singleton row.
//     pickMetric(gi, metricKey)      — append a numeric condition to group `gi`.
//     preselectPhase(v) / preselectFielding(field,value) /
//       preselectMatchupVs(dim,value) / preselectEdge(edge) /
//       preselectInningsNumber(n)    — the ▸-variant pre-fill closures.
//     getVsBowlingTypes()          — () => the cached fine-bowling-type list
//                                     (or null before the first load resolves).
//     ensureVsBowlingTypesLoaded() — kick off the lazy load iff nothing is
//                                     cached yet (idempotent; the retry-on-
//                                     failure behaviour lives in the caller's
//                                     implementation, unchanged from before).
//
// `surface` ("leaderboard" default | "popup"): "leaderboard" is TODAY'S full
// taxonomy, byte-identical to the pre-extraction version.
//
// "popup" (player pop-up Tab-2 "Filters", consumed by playerFiltersTab.js →
// playerFilterEditor.js) offers ONLY the per-innings SLICE filter set the tab's
// engine (T-2b-i) can compute for one player's record:
//   • Metric leaves are kept iff `metricSliceable(key, disc)` — the ✅ per-innings
//     amounts / rates / thresholds (Innings Score, Wicket Hauls) + the Y/N
//     booleans (Ducks, Not Outs, dismissal-type, PotM). The ❌ column-only
//     metrics (Batting/Bowling Average, Bowling Strike Rate, High Score, Best
//     Bowling, Matches, 50s/100s, Balls per…) fall out automatically.
//   • Innings Score / Wicket Hauls read plainly (full-operator numeric editor),
//     not the leaderboard's "≥ N" count shape; PotM is added as a Y/N leaf.
//   • The SCOPE SINGLETONS in POPUP_SCOPE_SINGLETON_KEYS (Team / Opposition / Event
//     / Venue / Stage / Match & Toss Result / Innings Number + the ball-engine
//     vs-opponent / four delivery-window keys) are OFFERED (T-2c): leafSingle /
//     singleFamily / matchResultFamily return real leaves whose value editor is a
//     store-adapter reuse of the drawer's own singleton editors
//     (src/playerFilterScope.js). Their clauses come from the row's clean-state
//     buildQuery (buildScopeClauses / buildMatchContextClauses) — buildQuery is
//     UNCHANGED (numbers sacred) and an empty selection is byte-identical.
//   • Still WITHHELD (→ null): the matchup "Vs" entries (vs bowling style / vs
//     batting hand / batting position — they route through buildMatchupQuery, a
//     different path this tab never uses) and fielding position (its per-innings
//     source lands in T-3). Held back — NOT dropped from the design — to keep
//     every offered filter honest (SPEC §8.4).
// Only the "popup" branch changes; the leaderboard taxonomy is byte-untouched.

import { effectiveNamespace, matchupVsActive, eligibleMetrics, FIELDING_POSITIONS, inningsNumberOptions } from "./state.js";
import { DIM_BY_KEY as FIELDING_DIM_BY_KEY } from "./fieldingDims.js";
import { ballEngineEnabled } from "./config.js";
import { matchupBucketLabel, metricDisplayLabel } from "./metrics.js";
import { partitionFilterMetrics } from "./advanced.js";
import { windowPhaseBallsAllowed } from "./drawerInnings.js";

// ── Filter-rejig Wave R2: metrics DELETED from the "+ Add condition" PICKER ──
// (moved verbatim from drawer.js, decision 68 / filter-rejig-spec.md "Deletes")
// — display-only removal from the filter list. The metric DEFINITIONS +
// columns + data STAY in metrics.js — these keys are only withheld from
// buildPaletteGroups' offered leaves, so the query builders are untouched
// (numbers sacred). Cut ONLY for genuine redundancy / owner-cut, never niche:
//   • ALL per-phase metrics (Powerplay/Middle/Death SR/Econ/Wkts + ODI variants,
//     batting + bowling) — subsumed by Ball Ranges: Phase + the base metric.
//     Caught generically by `isPhaseMetric` truthy, so no key list can drift.
//   • Progression SR (first-10 / 11–20 / 21+) — subsumed by Batter/Bowler Ball
//     Range + Strike Rate.
//   • Wickets per Innings, Not Out % — owner cuts. Dismissals Effected —
//     re-summed from catches+stumpings+run-outs.
//   Columns-popup rework Wave A (#25, owner 2026-08-12): "Boundary % Conceded"
//   (balls-based) is RESTORED as a bowling Detailed filter leaf below — the
//   owner's flag-off review wanted both the balls-based % and Boundary Run %
//   offered, not one replacing the other. No longer in this set.
const DELETED_FILTER_METRIC_KEYS = new Set([
  "sr_first10", "sr_11_20", "sr_21plus",
  "wickets_per_innings", "not_out_pct", "dismissals_effected",
]);
const isDeletedFilterMetric = (m) => Boolean(m.isPhaseMetric) || DELETED_FILTER_METRIC_KEYS.has(m.key);

// Dismissal-type labels drop the leading "Out " (R5 Wave 1a, item 7: "Caught"
// not "Out Caught"). Display-only — the metric KEYS/labels in metrics.js are
// untouched; this strips the prefix at render time only. The bowling wkt_*
// labels have no "Out " prefix, so this is a no-op for them.
const stripOutPrefix = (label) => label.replace(/^Out\s+/, "");

// T-F3: the "popup" surface's Player-Profile exclusions (see file header). Any
// other surface (i.e. "leaderboard") excludes nothing — same 6 leaves as today.
const POPUP_EXCLUDED_PLAYER_PROFILE_LEAVES = new Set(["role", "hand", "bowling", "bowlingHand", "potm_count"]);

// T-2c: the SCOPE SINGLETONS the player pop-up ("popup" surface) now OFFERS as
// per-row filters (owner 2026-08-03). Each flows through the row's clean-state
// buildQuery — buildScopeClauses (Team / Opposition / Event / Venue / Innings
// Number) and buildMatchContextClauses (Match & Toss Result / Stage) apply them as
// WHERE, so buildQuery stays UNCHANGED (numbers sacred) and an empty selection is
// byte-identical. Their value editors are a store-adapter reuse of the drawer's own
// singleton editors (src/playerFilterScope.js). Everything a "popup" surface still
// WITHHOLDS is simply absent from this set: the Player-Profile leaves
// (role/hand/bowling — also excluded above), the matchup "Vs" entries (vs
// bowling style / vs batting hand / batting position, which route through
// buildMatchupQuery — a different path this tab never uses; a separate follow-up),
// and fielding (its per-innings source lands in T-3). vs_opp + the four Ball-Ranges
// window keys are included too: they are ball-engine-gated by the existing `ballOn`
// guards below, and their per-call {opponentPlayer, deliveryWindow} threading is the
// T-2b-i db.query path (not buildScopeClauses). Consulted ONLY on the "popup"
// surface — leafSingle / singleFamily / matchResultFamily are byte-untouched on the
// leaderboard.
const POPUP_SCOPE_SINGLETON_KEYS = new Set([
  "team", "opposition", "event", "venue", "city", "season", "mc_stage",
  "mc_result", "mc_toss_result", "mc_toss_decision", "inn_num",
  "vs_opp", "win_phase", "win_overs", "win_balls", "win_player",
]);
const popupWithholdsSingleton = (surface, key) => surface === "popup" && !POPUP_SCOPE_SINGLETON_KEYS.has(key);

// ── Chunk 5 · Phase 1: Player / Scope lane split (LAYOUT ONLY) ─────────────────
// The leaderboard's "+ Add condition" menu is split into TWO dropdowns-in-a-row —
// **Player Filters** (who qualifies) and **Scope Filters** (which matches/deliveries
// the numbers come from) — mirroring the columns section's dropdowns-in-a-row. This
// is a DISPLAY reorg only: the SAME leaf `run()` closures fire, so buildQuery /
// buildScopeClauses / conditionToHaving are untouched (numbers sacred). Opt-in via
// the `lane` option below — every OTHER caller (the player pop-up "Filters" tab, any
// legacy call) passes NO lane, so `finalize` is a no-op and the returned taxonomy is
// BYTE-IDENTICAL to before this split. The per-item `lane` / `section` props added
// for tagging are inert on the un-laned path (addPalette.js ignores unknown props).
//
// A GROUP's default lane; per-item `.lane` overrides it for the handful of leaves
// that live in a differently-laned group (owner rulings: Team is SCOPE though it
// sits in the "Player Profile" UI group; Batting position's final home is Scope).
const GROUP_DEFAULT_LANE = {
  // batting / bowling groups
  "Player Profile": "player",
  "Match Details": "scope",
  "Batting · Basic Stats": "player",
  "Bowling · Basic Stats": "player",
  "Batting · Detailed Stats": "player",
  "Bowling · Detailed Stats": "player",
  "Ball Ranges": "scope",
  "Matchup (Vs)": "scope",
  "Fielding Stats": "player", // wicket-type COUNT family = Player; fld_pos tagged Scope per-item
  // fielding board groups
  "Fielder Profile": "player", // Matches = Player; Team tagged Scope per-item
  Match: "scope",
  "Wicket Types": "player",
  "Bowler Details": "scope",
  "Dismissed Batter": "scope",
};
// The ordered section list each lane's dropdown renders (only present sections show).
// Batting/bowling and fielding-board section names both appear; the two are mutually
// exclusive per discipline, so the filter drops whatever isn't present.
const PLAYER_LANE_SECTIONS = [
  "Player Profile", "Fielder Profile",
  "Batting · Basic Stats", "Bowling · Basic Stats", "Wicket Types",
  "Batting · Detailed Stats", "Bowling · Detailed Stats",
  "Fielding Stats",
];
const SCOPE_LANE_SECTIONS = [
  "Match Details", "Match", "Ball Ranges", "Matchup (Vs)",
  "Bowler Details", "Dismissed Batter", "Fielding Stats",
];
// Attach a lane (and optional re-home section) to an item; null-safe so it can wrap a
// builder that returned null (e.g. a popup-withheld singleton).
const withLane = (item, laneVal, section) =>
  item ? { ...item, lane: laneVal, ...(section ? { section } : {}) } : item;

/**
 * Bind the taxonomy builder to one surface's instance closures (its own store,
 * DOM, singleton bookkeeping). Returns `buildPaletteGroups(s, gi, {surface, lane})`.
 */
export function createPaletteGroupsBuilder(deps) {
  const {
    isPresent, SINGLETON_TYPES,
    pickSingleton, pickMetric,
    preselectPhase, preselectFielding, preselectMatchupVs, preselectEdge, preselectInningsNumber,
    getVsBowlingTypes, ensureVsBowlingTypesLoaded,
    // DATA-DRIVEN availability (owner "remove the hardcode everywhere",
    // 2026-08-03) — replaces the old `!women` gates on the Player-Profile leaves
    // (role/hand/bowling) and the Matchup "Vs" family. `isFilterAvailable(key, s)`
    // is a SYNC getter over an async-loaded per-gender cache (src/filterAvailability.js),
    // wired by each surface (drawer + pop-up editor); `ensureFilterAvailabilityLoaded(s)`
    // kicks off that load. Defaults keep an un-wired surface offering everything
    // (optimistic) rather than silently hiding a men filter. Display-only — no
    // query builder is consulted here (numbers sacred).
    isFilterAvailable = () => true,
    ensureFilterAvailabilityLoaded = () => {},
    // T-2b-ii: the pop-up ("popup" surface) offers a metric leaf ONLY when it is
    // a per-innings SLICEABLE filter (numeric amount/rate/threshold or Y/N
    // boolean) — supplied by the pop-up mount (playerFiltersTab.js) as the slice
    // engine's single source of truth. Absent on the leaderboard surface (drawer.js
    // passes none), so the full leaderboard taxonomy is byte-untouched.
    metricSliceable,
    // Fielding board (3.2b2): the leaderboard drawer supplies these so the
    // `disc === "fielding"` branch can offer the fielding dim rows
    // (src/fieldingDimsDrawer.js). No other surface hits that branch (the pop-up's
    // fielding mode uses playerFieldingEditor.js and reports getDiscipline()="batting"),
    // so the defaults keep every other caller byte-identical.
    pickFieldingDim = () => {},
    fieldingDimOfferable = () => false,
    fieldingDimPresent = () => false,
  } = deps;

  /**
   * Build the 7-group palette taxonomy for the current state, with each metric
   * condition targeting group `gi`. Returns [{ name, note?, items }]; an item is
   * { kind:'leaf', label, disabled?, run } or { kind:'family', label, disabled?,
   * variants:[leaf…] }. Discipline-aware, gender/format/matchup gated exactly as
   * the old dropdown was. Metric leaves are drawn from the SAME source the old
   * dropdown used — partitionFilterMetrics(eligibleMetrics(ns)) minus the deletes —
   * but the palette shows EXACTLY the spec's target list: every leaf is placed
   * by name (R2b removed the former "leftoverLeaves" catch-all that auto-appended
   * any un-placed eligible metric to Detailed). At the time, this dropped a handful
   * of matchup-namespace metrics that were only reachable via that catch-all
   * (Balls Faced / Dismissals in matchup_batting; Fours Conceded / Sixes Conceded
   * in matchup_bowling) — since restored by name: Balls Faced in Wave R2c (see the
   * "Matchup-namespace restore" comment below), and Dismissals / Fours Conceded /
   * Sixes Conceded in R4-B (owner ruling 6, 2026-08-09, see the matching comments
   * below). All four are offered as filters in Vs mode again today.
   *
   * `surface` ("leaderboard" default | "popup") — see file header. Only the
   * Player Profile group (#1) varies by surface; every other group is built
   * identically regardless.
   */
  function buildPaletteGroups(s, gi, { surface = "leaderboard", popupLock = null, lane = null } = {}) {
    // Chunk 5 · Phase 1: when a `lane` ("player" | "scope") is requested (the
    // leaderboard's two-dropdown layout), redistribute the full taxonomy's items
    // into that lane's ordered section list. No `lane` (pop-up / legacy) → the full
    // taxonomy, byte-identical. Display-only — never a query path.
    const finalize = (gs) => {
      if (!lane) return gs;
      const bySection = new Map();
      for (const g of gs) {
        const groupLane = GROUP_DEFAULT_LANE[g.name] || "scope";
        for (const it of g.items) {
          const itLane = it.lane || groupLane;
          if (itLane !== lane) continue;
          const sec = it.section || g.name;
          if (!bySection.has(sec)) bySection.set(sec, []);
          bySection.get(sec).push(it);
        }
      }
      const order = lane === "player" ? PLAYER_LANE_SECTIONS : SCOPE_LANE_SECTIONS;
      return order.filter((name) => bySection.has(name)).map((name) => ({ name, items: bySection.get(name) }));
    };
    const excludeLeaf = (key) => surface === "popup" && POPUP_EXCLUDED_PLAYER_PROFILE_LEAVES.has(key);
    const ns = effectiveNamespace(s);
    const disc = s.discipline;
    // Kick off the data-driven availability load for this scope (idempotent per
    // gender); when it resolves the surface re-renders so the offered leaves
    // settle. Until then isFilterAvailable is optimistic (see deps note).
    ensureFilterAvailabilityLoaded(s);
    const matchup = matchupVsActive(s);
    const ballOn = ballEngineEnabled();
    const winPB = windowPhaseBallsAllowed(s);

    // T-2e (owner Option A, 2026-08-03): on the "popup" surface a row is EITHER a
    // matchup-Vs row — which routes through buildMatchupQuery and therefore combines
    // ONLY with the buildScope/matchContext scope singletons — OR a per-innings-SLICE
    // row (combines with scope + more slices). NEVER both: buildMatchupQuery ignores
    // the inningsWhere slices AND the ball predicates (vs_opp / delivery window), so
    // mixing them would SILENTLY drop the slice — the exact "do not silently ignore"
    // trap. `popupLock` is computed by the editor from the row's live draft
    // ("matchup" | "slice" | null); these four gates enforce the exclusivity honestly
    // in the offered palette. All inert off the popup surface — the leaderboard
    // taxonomy is BYTE-UNTOUCHED.
    const popupMatchupLocked = surface === "popup" && popupLock === "matchup"; // hide per-innings slices + ball predicates
    const popupMatchupOffered = surface === "popup" && popupLock === null;     // offer matchup-Vs only on an EMPTY row
    const popupSliceOffered = surface === "popup" && popupLock !== "matchup";  // offer slices + ball predicates unless matchup-locked

    // Drop the deleted-filter keys before partitioning (same source as the old picker).
    const numericMetrics = eligibleMetrics(ns, s.formats)
      .filter((m) => !isDeletedFilterMetric(m));
    const parts = partitionFilterMetrics(numericMetrics);
    const eligibleByKey = new Map(numericMetrics.map((m) => [m.key, m]));

    const presentSingles = new Set(SINGLETON_TYPES.filter((t) => isPresent(t, s)).map((t) => t.key));
    const singlePresent = (key) => presentSingles.has(key);

    // ── item builders ──────────────────────────────────────────────────────────
    const leafMetric = (key, label) => {
      const m = eligibleByKey.get(key);
      if (!m) return null; // not eligible in this namespace/format — skip gracefully
      // T-2e: a matchup-Vs row (popupMatchupLocked) combines ONLY with scope
      // singletons — every per-innings metric SLICE is withheld (buildMatchupQuery
      // never sees inningsWhere). Inert off the popup surface.
      if (popupMatchupLocked) return null;
      // Pop-up surface: withhold the ❌ column-only metrics (Average, Bowling SR,
      // High Score, Best, Matches, 50s/100s, Balls per…) — a metric is offered
      // as a FILTER here iff the slice engine can slice it (metricSliceable is
      // the drift-proof source of truth). Never consulted on the leaderboard.
      if (surface === "popup" && metricSliceable && !metricSliceable(key, disc)) return null;
      return { kind: "leaf", label: label ?? metricDisplayLabel(m, s.formats), metricKey: key, run: () => pickMetric(gi, key) };
    };
    // Pop-up surface (T-2c): OFFERS the scope singletons in POPUP_SCOPE_SINGLETON_KEYS
    // (Team / Opposition / Event / Venue / Stage / Match & Toss Result / Innings
    // Number + the ball-engine vs-opponent / delivery-window keys), each with the
    // store-adapter value editor wired through pickSingleton (src/playerFilterScope.js);
    // still WITHHOLDS every other singleton (the matchup "Vs" entries route through
    // buildMatchupQuery and fielding needs the T-3 source — showing either without a
    // working data path would be a dishonest filter, SPEC §8.4). Byte-untouched on
    // the leaderboard surface.
    const leafSingle = (key, label, preselect = null) => {
      if (popupWithholdsSingleton(surface, key)) return null;
      return { kind: "leaf", label, disabled: singlePresent(key), run: () => pickSingleton(key, preselect) };
    };
    const metricFamily = (label, variantDefs) => {
      const variants = variantDefs.map(([key, vlabel]) => leafMetric(key, vlabel)).filter(Boolean);
      return variants.length ? { kind: "family", label, variants } : null;
    };
    // A categorical ▸ family bound to ONE singleton: variants pre-select a value;
    // the family + variants disable once that singleton row is present.
    const singleFamily = (label, key, variantDefs) => {
      if (popupWithholdsSingleton(surface, key)) return null; // pop-up offers only the POPUP_SCOPE_SINGLETON_KEYS families (see leafSingle)
      const present = singlePresent(key);
      const variants = variantDefs.map(([vlabel, preselect]) => ({
        kind: "leaf", label: vlabel, disabled: present, run: () => pickSingleton(key, preselect),
      }));
      return { kind: "family", label, disabled: present, variants };
    };
    // T-2e (owner Option A): the matchup-Vs family ("vs bowling style" / "vs batting
    // hand"). On the LEADERBOARD it is singleFamily("…", "vs", …) — BYTE-UNTOUCHED. On
    // the POPUP it is NOT a buildScope singleton (matchupVs lives on the ROW, routed
    // through buildMatchupQuery), so it bypasses the popup scope-singleton withhold and
    // is offered ONLY on an empty row (popupMatchupOffered). Its variants set the row's
    // matchupVs draft via the editor's pickSingleton("vs") + preselectMatchupVs (a Vs
    // pick is a whole-row mode, not a stacked condition), so once present the family is
    // hidden (the row is now popupLock === "matchup").
    const matchupVsFamily = (label, variantDefs) => {
      if (surface !== "popup") return singleFamily(label, "vs", variantDefs);
      if (!popupMatchupOffered) return null;
      return {
        kind: "family", label,
        variants: variantDefs.map(([vlabel, preselect]) => ({
          kind: "leaf", label: vlabel, run: () => pickSingleton("vs", preselect),
        })),
      };
    };
    const pushGroup = (name, items, note) => {
      const kept = items.filter(Boolean);
      if (kept.length) groups.push({ name, note, items: kept });
    };

    const groups = [];

    // 0 ── FIELDING BOARD (3rd leaderboard scope) ─────────────────────────────────
    // A completely separate, HONEST offer set — only filters the fielding leaderboard
    // query (buildFieldingLeaderboardQuery) actually narrows by. Returns EARLY, so the
    // batting/bowling/matchup taxonomy below is byte-untouched (it is never reached for
    // fielding). Fixes the pre-existing bug where disc==="fielding" fell into the
    // BOWLING else-branch and offered top-level Stage/Result/Toss (silently ignored by
    // the fielding query) + null metric leaves (the fielding namespace has no metrics).
    if (disc === "fielding") {
      // 3.2c menu reorg (owner-approved, 2026-08-15): SIX groups in a fixed order —
      // Fielder Profile · Match · Ball Ranges · Wicket Types · Bowler Details ·
      // Dismissed Batter. Display-only reshuffle of the SAME honest offer set (only
      // filters the fielding query actually narrows by), plus ONE new count filter
      // (Caught & bowled — see Wicket Types below). Retired here: the old "Player
      // Profile" fielding group (Playing role / Batting hand / Bowling style / Bowling
      // hand) and the "Wicket type" checklist picker (dimLeaf("kind")) — both dropped
      // as redundant (owner ruling); Team survives, moved into Fielder Profile.

      // Count-threshold tallies resolve under the "batting" catalogue — the fielding
      // board has no "fielding" metrics namespace; buildFieldingCountGate /
      // conditionToFieldingWhere resolve the SAME keys under "batting"
      // (metricNsFor(fielding)="batting"). Offer EXACTLY the keys the count gate honors
      // (FIELDING_CONDITION_COLUMNS) — anything else the gate silently drops (dishonest).
      const battingByKey = new Map(eligibleMetrics("batting", s.formats).map((m) => [m.key, m]));
      const tallyLeaf = (key, label) => {
        const m = battingByKey.get(key);
        if (!m) return null;
        return { kind: "leaf", label, metricKey: key, run: () => pickMetric(gi, key) };
      };
      // A fielding DIM leaf (→ state.fielding.<field>), offered only when its (possibly
      // data-driven) option list is non-empty; disabled once its row is present. Its
      // run() reveals the drawer's inline dim row (fieldingDimsDrawer.js).
      const dimLeaf = (dimKey) => {
        const dim = FIELDING_DIM_BY_KEY.get(dimKey);
        if (!dim || !fieldingDimOfferable(dimKey, s)) return null;
        return { kind: "leaf", label: dim.label, disabled: fieldingDimPresent(dimKey, s), run: () => pickFieldingDim(dimKey) };
      };

      // 1 ── Fielder Profile ─────────────────────────────────────────────────────
      // The FIELDER-level scope: Matches count (moved from the old Fielding Tallies)
      // + Team singleton (moved from the retired Player Profile group).
      pushGroup("Fielder Profile", [
        tallyLeaf("matches", "Matches"),
        // Chunk 5: Team is SCOPE (owner ruling) — re-homed into the "Match" section
        // of the Scope dropdown when laned. Inert (byte-identical) on the un-laned path.
        withLane(leafSingle("team", "Team"), "scope", "Match"),
      ]);
      // 2 ── Match ───────────────────────────────────────────────────────────────
      // Scope singletons (honoured top-level) + the match-context fielding dims
      // (City/Season/Stage/Result/Toss reach `matches` via the fielding query's EXISTS,
      // NOT the top-level state.stage/result/… the fielding query ignores). Team is
      // now in Fielder Profile (above).
      pushGroup("Match", [
        leafSingle("opposition", "Opposition"),
        leafSingle("event", "Event"),
        leafSingle("venue", "Venue"),
        dimLeaf("city"),
        dimLeaf("season"),
        dimLeaf("stage"),
        dimLeaf("result"),
        dimLeaf("tossResult"),
        dimLeaf("tossDecision"),
      ]);
      // 3 ── Ball Ranges (was "Delivery") ────────────────────────────────────────
      pushGroup("Ball Ranges", [dimLeaf("phase"), dimLeaf("overs"), dimLeaf("innings")]);
      // 4 ── Wicket Types (was "Fielding Tallies") ───────────────────────────────
      // Catches · Caught & bowled · Stumpings · Run-outs · Total dismissals. Matches
      // moved to Fielder Profile. "Caught & bowled" (NEW, 3.2c) is its OWN count filter
      // — a distinct subset of Catches; Catches still folds c&b in (unchanged). It maps
      // to the additively-projected `caught_and_bowled` alias + FIELDING_CONDITION_COLUMNS
      // gate (table.js); the metric resolves under the "batting" catalogue like its siblings.
      pushGroup("Wicket Types", [
        tallyLeaf("catches", "Catches"),
        tallyLeaf("caught_and_bowled", "Caught & bowled"),
        tallyLeaf("stumpings", "Stumpings"),
        tallyLeaf("run_outs", "Run-outs"),
        tallyLeaf("dismissals_effected", "Total dismissals"),
      ]);
      // 5 ── Bowler Details (was "Bowler") ───────────────────────────────────────
      pushGroup("Bowler Details", [dimLeaf("bowlerStyle"), dimLeaf("bowler")]);
      // 6 ── Dismissed Batter (was "Dismissed batter") ───────────────────────────
      // The dims about WHO was out — the "Wicket type" checklist picker (dimLeaf("kind"))
      // is retired (redundant with Wicket Types' count filters). Position stays on the
      // existing fld_pos singleton (byte-identical everywhere; no duplicate dim row). The
      // "hand" dim now reads "Dismissed batter hand" (fieldingDims.js). "Batter role"
      // (dimLeaf("role")) is retired here (owner ruling 2026-08-16: "doesn't work here")
      // — the dim definition stays in fieldingDims.js; only the offer is removed.
      pushGroup("Dismissed Batter", [
        leafSingle("fld_pos", "Dismissed batter's position"),
        dimLeaf("hand"),
        dimLeaf("batter"),
      ]);
      return finalize(groups);
    }

    // 1 ── Player Profile ────────────────────────────────────────────────────────
    // T-F3: each of the 4 fixed profile leaves + PotM Count is withheld on the
    // "popup" surface via excludeLeaf (see file header); Team is never excluded.
    pushGroup("Player Profile", [
      // Data-driven (owner 2026-08-03): each profile leaf is offered iff its
      // profile data exists for the current scope (men → yes, women today → no,
      // future women's data → auto-shown) — replaces the old `!women` gate.
      isFilterAvailable("profileRole", s) && !excludeLeaf("role") ? leafSingle("role", "Playing role") : null,
      isFilterAvailable("profileHand", s) && disc === "batting" && !excludeLeaf("hand") ? leafSingle("hand", "Batting hand") : null,
      isFilterAvailable("profileBowling", s) && !excludeLeaf("bowling") ? leafSingle("bowling", "Bowling style") : null,
      // Bowling hand (owner #8): dedicated `bowling_arm` profile column
      // ("Right"/"Left"). Mirrors Bowling style exactly — same group, same
      // single-select panel, same data-driven availability, same popup exclusion.
      isFilterAvailable("profileBowlingArm", s) && !excludeLeaf("bowlingHand") ? leafSingle("bowlingHand", "Bowling hand") : null,
      // PotM Count (R2b): the filterable count of Player-of-the-Match awards
      // (metrics.js `potm_count`), in the Player Profile group. The
      // old `player_of_match` (Impact section) is no longer offered as a filter.
      !excludeLeaf("potm_count") ? leafMetric("potm_count", "PotM Count") : null,
      // PotM (Y/N) (Wave D — TASK B): the LEADERBOARD's Yes/No singleton filter
      // (state.potmYN → a HAVING gate on the pom_cte award count), beside PotM Count.
      // leafSingle self-WITHHOLDS it on the "popup" surface (potm_yn is not in
      // POPUP_SCOPE_SINGLETON_KEYS), so the pop-up keeps its OWN per-innings "PotM
      // (Y/N)" slice (metricKey "potm", added below) untouched — no collision.
      leafSingle("potm_yn", "PotM (Y/N)"),
      // Pop-up (T-2b-ii, owner 2026-08-03): PotM as a per-innings Y/N slice
      // (metrics.js has no `potm` metric — this is a bespoke boolean condition the
      // slice engine resolves via a match-award EXISTS). Replaces PotM Count here.
      // T-2e: it is a per-innings slice, so it's withheld on a matchup-Vs row.
      surface === "popup" && !popupMatchupLocked ? { kind: "leaf", label: "PotM (Y/N)", metricKey: "potm", run: () => pickMetric(gi, "potm") } : null,
      // Chunk 5: Team is SCOPE (owner ruling — it sits in this Player Profile UI group
      // but is a match-scope filter), re-homed into "Match Details" in the Scope
      // dropdown when laned. Inert (byte-identical) on the un-laned pop-up path.
      withLane(leafSingle("team", "Team"), "scope", "Match Details"),
    ]);

    // 2 ── Match Details ─────────────────────────────────────────────────────────
    const matchResultFamily = {
      kind: "family", label: "Match/Toss Result",
      variants: [
        { kind: "leaf", label: "Match Result", disabled: singlePresent("mc_result"), run: () => pickSingleton("mc_result") },
        { kind: "leaf", label: "Toss Result", disabled: singlePresent("mc_toss_result"), run: () => pickSingleton("mc_toss_result") },
        { kind: "leaf", label: "Toss Decision", disabled: singlePresent("mc_toss_decision"), run: () => pickSingleton("mc_toss_decision") },
      ],
    };
    pushGroup("Match Details", [
      leafSingle("opposition", "Opposition"),
      leafSingle("event", "Event"),
      leafSingle("venue", "Venue"),
      // City / Season (City & Season everywhere, 2026-08-16): standalone match-level
      // filters mirroring Event/Venue, offered in Match Details on batting + bowling.
      leafSingle("city", "City"),
      leafSingle("season", "Season"),
      leafSingle("mc_stage", "Stage"),
      // "Innings order" (batted / bowled first) was replaced by Innings Number ▸
      // (Wave R2c), now live in Batting & Bowling Basic Stats. Its old plumbing
      // (mc_innings_order singleton row/editor/pill/state/clause) was fully torn
      // down in the waveR2-cleanup pass — no gap, the entry point moved.
      // Match/Toss Result (T-2c): OFFERED on the pop-up too — all three of its
      // variant keys (mc_result / mc_toss_result / mc_toss_decision) are in
      // POPUP_SCOPE_SINGLETON_KEYS, revealed by the store-adapter editors. Their
      // clauses come from buildMatchContextClauses (buildQuery unchanged).
      matchResultFamily,
    ]);

    // 3/4 ── Batting / Bowling metric groups (discipline-specific) ────────────────
    const dismissalVariant = (m) => [m.key, stripOutPrefix(metricDisplayLabel(m, s.formats))];
    // Innings Number ▸ (Wave R2c): the categorical scope family (revealing the
    // inn_num singleton row, one variant per selectable innings). Format-aware
    // variants (1st/2nd white-ball, up to 4th when Red Ball is selected). Placed
    // right after "Innings" in BOTH Basic Stats groups (spec).
    const inningsNumberFamily = () =>
      singleFamily(
        "Innings Number",
        "inn_num",
        inningsNumberOptions(s.formats).map((o) => [o.label, preselectInningsNumber(o.value)])
      );
    if (disc === "batting") {
      pushGroup("Batting · Basic Stats", [
        leafMetric("matches", "Matches"),
        leafMetric("innings", "Innings"),
        // Chunk 5: Innings Number is SCOPE — re-homed into "Match Details" (Scope
        // dropdown) when laned. Inert (byte-identical) on the un-laned pop-up path.
        withLane(inningsNumberFamily(), "scope", "Match Details"),
        // Position rework (owner-authorised 2026-08-14): the honest "Batting position"
        // filter (state.positions → `batting_position IN (…)` via buildScopeClauses)
        // is now offered in PLAIN batting too, not just matchup. It reuses the SAME
        // `strikerpos` singleton control + editor the matchup Vs group uses (below).
        // Gated `!matchup` so it shows HERE in plain batting and in the Vs group under
        // a matchup — never both. leafSingle self-withholds on the popup surface
        // (strikerpos ∉ POPUP_SCOPE_SINGLETON_KEYS), so the pop-up keeps its own
        // per-innings `batting_position` slice below — no collision.
        // Chunk 5: Batting position's final home is SCOPE (owner ruling) — re-homed
        // into "Match Details" (Scope dropdown) when laned. Inert on the un-laned path.
        !matchup ? withLane(leafSingle("strikerpos", "Batting position"), "scope", "Match Details") : null,
        // T-2e (owner 2026-08-03): Batting position — a batting-only, per-innings LIST
        // slice on the plain `batting` view's `batting_position` (compiles to
        // `batting_position IN (…)` via inningsWhere). Popup-only + withheld on a
        // matchup-Vs row (a per-innings slice). Bowling's "batting position" is the
        // matchup striker-position path, so it is NOT offered on the bowling tab.
        surface === "popup" && !popupMatchupLocked && disc === "batting"
          ? { kind: "leaf", label: "Batting position", metricKey: "batting_position", run: () => pickMetric(gi, "batting_position") }
          : null,
        leafMetric("runs", "Runs"),
        leafMetric("balls_faced", "Balls Faced"),
        // Matchup-namespace restore (Wave R2c): matchup_batting's "Balls Faced" metric
        // has KEY "balls" (not "balls_faced"), so the line above — which resolves in
        // PLAIN batting — skips it in matchup mode. This companion places it in
        // matchup-batting (ns = matchup_batting) and is null (skipped) in plain
        // batting, where key "balls" doesn't exist — so exactly ONE "Balls Faced"
        // shows per namespace, never both.
        leafMetric("balls", "Balls Faced"),
        leafMetric("fours", "4s"),
        leafMetric("sixes", "6s"),
        metricFamily("Dismissal Type", parts.dismissal.map(dismissalVariant)),
        leafMetric("ducks", "Ducks"),
        leafMetric("not_outs", "Not Outs"),
        // R4-B (owner ruling 6, 2026-08-09): "Dismissals" is now offered as a plain
        // BATTING filter on the leaderboard too — closing the filter/column asymmetry
        // (Columns Wave B added the plain batting `dismissals` COLUMN of this same
        // key). `getMetric("dismissals","batting")` resolves that plain metric
        // (sqlExpression SUM(dismissed) — the `average` denominator) and
        // conditionToHaving compiles `SUM(dismissed) <op> N`; in matchup batting it
        // still resolves matchup_batting's own `dismissals`. buildQuery is UNCHANGED
        // — this only reuses existing sqlExpression via the existing HAVING path
        // (numbers sacred). `surface !== "popup" || matchup` keeps the POP-UP surface
        // byte-identical: plain dismissals is NOT sliceable there (not in the pop-up
        // slice set), and on a matchup pop-up row leafMetric self-nulls — so the
        // pop-up is untouched (its plain-Dismissals offering is a separate R5 task).
        (surface !== "popup" || matchup) ? leafMetric("dismissals", "Dismissals") : null,
        leafMetric("high_score", "High Score"),
        leafMetric("fifties", "50s"),
        leafMetric("hundreds", "100s"),
        // R2 (2026-08-09): the leaderboard filter is a full-operator existence gate
        // on the innings' runs (≥/≤/=/between chosen in the editor), so the add-menu
        // leaf reads "Innings Score" on BOTH surfaces — the hardcoded "≥ N" is gone.
        // Columns-popup rework Wave A (#18, owner 2026-08-12): "(Min/Max)" appended
        // so the leaf's purpose (a range-editor filter, not a fixed "≥ N") is clear.
        leafMetric("innings_score_ge", "Innings Score (Min/Max)"),
      ]);
      pushGroup("Batting · Detailed Stats", [
        leafMetric("average", "Batting Average"),
        leafMetric("strike_rate", "Batting Strike Rate"),
        leafMetric("balls_per_dismissal", "Balls per Dismissal"),
        leafMetric("boundary_pct", "Boundary Ball %"),
        leafMetric("boundary_runs_pct", "Boundary Run %"),
        leafMetric("dot_pct", "Dot Ball %"),
        // Columns-popup rework Wave A (#19, owner 2026-08-12): the FILTER leaf reads
        // the full metric name; the metrics.js `shortLabel` ("NBSR") still drives the
        // compact COLUMN header (table.js reads shortLabel, not label — unaffected).
        leafMetric("running_sr", "Non-Boundary Strike Rate"),
        leafMetric("balls_faced_share", "Percentage of Balls Faced"),
        metricFamily("Balls per…", [["balls_per_boundary", "Boundary"], ["balls_per_four", "4"], ["balls_per_six", "6"]]),
        metricFamily("% Runs in…", [
          ["runs_1s_pct", "1s"], ["runs_2s_pct", "2s"], ["runs_3s_pct", "3s"],
          ["runs_4s_boundary_pct", "4s-boundary"], ["runs_4s_run_pct", "4s-run"],
          ["runs_5s_pct", "5s"], ["runs_6s_boundary_pct", "6s-boundary"], ["runs_6s_run_pct", "6s-run"],
        ]),
      ]);
    } else {
      pushGroup("Bowling · Basic Stats", [
        leafMetric("matches", "Matches"),
        leafMetric("innings", "Innings"),
        // Chunk 5: Innings Number is SCOPE — re-homed into "Match Details" (Scope
        // dropdown) when laned. Inert (byte-identical) on the un-laned pop-up path.
        withLane(inningsNumberFamily(), "scope", "Match Details"),
        leafMetric("overs", "Overs"),
        leafMetric("balls", "Balls"),
        leafMetric("maidens", "Maidens"),
        leafMetric("runs_conceded", "Runs Conceded"),
        leafMetric("wickets", "Wickets"),
        // R4-B (owner ruling 6, 2026-08-09): "4s Conceded" / "6s Conceded" are now
        // offered as plain BOWLING filters on the leaderboard too — closing the
        // filter/column asymmetry (Columns Wave B added the plain bowling
        // `fours_conceded` / `sixes_conceded` COLUMNS of these same keys). In plain
        // bowling `getMetric` resolves those plain metrics (sqlExpression
        // SUM(fours_conceded) / SUM(sixes_conceded)) and conditionToHaving compiles
        // `SUM(fours_conceded) <op> N` etc.; buildQuery is UNCHANGED (numbers sacred).
        // The label is mode-dependent: plain uses the metric's own "4s/6s Conceded";
        // matchup keeps its existing "Fours/Sixes Conceded" label (a naming-sync is a
        // DEFERRED later task, ruling 6). `surface !== "popup" || matchup` keeps the
        // POP-UP surface byte-identical — these are engine-sliceable there but the
        // pop-up palette still WITHHOLDS them (a separate R5 task), so the plain arm
        // is leaderboard-only and a matchup pop-up row self-nulls in leafMetric.
        (surface !== "popup" || matchup) ? leafMetric("fours_conceded", matchup ? "Fours Conceded" : "4s Conceded") : null,
        (surface !== "popup" || matchup) ? leafMetric("sixes_conceded", matchup ? "Sixes Conceded" : "6s Conceded") : null,
        metricFamily("Wicket Types", parts.dismissal.map((m) => [m.key, metricDisplayLabel(m, s.formats)])),
        leafMetric("best", "Best Bowling"),
        // 4-WI / 5-WI removed (R2b): the fixed exactly-4 / 5-plus haul leaves are
        // superseded by the parametrised Wicket Hauls ≥ N ▸ below. The metric defs
        // (four_wicket_hauls / five_wicket_hauls) stay in metrics.js as columns.
        // R2 (2026-08-09): full-operator existence gate on the innings' wickets, so
        // the add-menu leaf reads "Wicket Hauls" on BOTH surfaces (see Innings Score).
        // Columns-popup rework Wave A (#18, owner 2026-08-12): "(Min/Max)" appended,
        // matching the Innings Score rename above.
        leafMetric("wicket_hauls_ge", "Wicket Hauls (Min/Max)"),
      ]);
      pushGroup("Bowling · Detailed Stats", [
        leafMetric("average", "Bowling Average"),
        leafMetric("economy", "Economy"),
        leafMetric("strike_rate", "Bowling Strike Rate"),
        metricFamily("Extras", [["extras_wides", "Wides"], ["extras_noballs", "No-balls"]]),
        leafMetric("dot_pct", "Dot Ball % Conceded"),
        // Columns-popup rework Wave A (#25, owner 2026-08-12): restored — was cut in
        // the filter-rejig (decision 68) on the theory Boundary Run % replaced it; the
        // owner's flag-off review wants both offered (this is balls-based, Boundary
        // Run % below is runs-based — different denominators, not duplicates).
        leafMetric("boundary_pct_conceded", "Boundary % Conceded"),
        // Columns-popup rework Wave A (#20, owner 2026-08-12): "Conceded" appended —
        // this label collided verbatim with the BATTING "Boundary Run %" leaf above
        // (same full label AND shortLabel "Bdry Run%"); metrics.js now disambiguates
        // via label + a distinct shortLabel ("Bdry Run% Con").
        leafMetric("boundary_runs_pct", "Boundary Run % Conceded"),
        // Wave C #24 (2026-08-12): the bowling mirror of the batting "% Runs in…"
        // family — filter a bowler on the SHARE of total runs conceded (which includes
        // wides + no-balls) coming from each of the five sources. The five partition
        // runs_conceded exactly, so the shares sum to 100. Catalogued runs_conc_*_pct
        // metrics (COLUMN home = the Runs Conceded by Source composer). Non-Boundary =
        // off-the-bat non-boundary runs (derived); source labels stay short.
        metricFamily("% Runs Conceded in…", [
          ["runs_conc_4s_pct", "4s"], ["runs_conc_6s_pct", "6s"],
          ["runs_conc_nonbdry_pct", "Non-Boundary"],
          ["runs_conc_wides_pct", "Wides"], ["runs_conc_noballs_pct", "No-balls"],
        ]),
      ]);
    }

    // 5 ── Ball Ranges (ball-engine only; folds the four delivery-window entries) ─
    // T-2e: the delivery-window pieces are ball predicates (threaded to db.query,
    // IGNORED by buildMatchupQuery), so the whole group is withheld on a matchup-Vs
    // row (popupSliceOffered false) — same exclusivity as vs_opp above.
    if (ballOn && (surface !== "popup" || popupSliceOffered)) {
      pushGroup("Ball Ranges", [
        winPB ? singleFamily("Phase", "win_phase", [
          ["Powerplay", preselectPhase("pp")], ["Middle", preselectPhase("mid")], ["Death", preselectPhase("death")],
        ]) : null,
        leafSingle("win_overs", "Over Range"),
        winPB ? leafSingle("win_balls", "Team Ball Range") : null,
        {
          kind: "family", label: "Batter/Bowler Ball Range", disabled: singlePresent("win_player"),
          variants: [
            { kind: "leaf", label: "First N", disabled: singlePresent("win_player"), run: () => pickSingleton("win_player", preselectEdge("first")) },
            { kind: "leaf", label: "Last N", disabled: singlePresent("win_player"), run: () => pickSingleton("win_player", preselectEdge("last")) },
          ],
        },
      ]);
    }

    // 6 ── Matchup (Vs) ───────────────────────────────────────────────────────────
    // T-F3: unaffected by `surface` — kept whole on "popup" (Team + every Matchup
    // entry stays). The profile-backed entries (vs bowling style / vs batting hand /
    // Batting position) are offered DATA-DRIVEN (owner "remove the hardcode
    // everywhere", 2026-08-03) — via isFilterAvailable, not the old `!women` gate.
    // Matchup rows key every bowler/batter through profiles, so today the mapped-
    // style data exists for men only (women are all '(unmapped)') → men offered,
    // women absent, identical to before; women's future profiles auto-restore it.
    // T-1's "vs opponent player" is GENDER-AGNOSTIC + ball-engine-gated (see below),
    // so the group can already surface on the women view (opponent-only) when on.
    {
      const vsItems = [];
      if (disc === "batting") {
        // vs bowling style — offered iff mapped bowling styles exist in scope.
        if (isFilterAvailable("vsBowlingStyle", s)) {
          const vsTypes = getVsBowlingTypes() || [];
          vsItems.push(matchupVsFamily("vs bowling style", [
            ["Pace", preselectMatchupVs("group", "Pace")],
            ["Spin", preselectMatchupVs("group", "Spin")],
            ...vsTypes.map((t) => [matchupBucketLabel(t), preselectMatchupVs("type", t)]),
          ]));
          // Fine bowling styles load lazily (matchup_batting distinct-values); once
          // they arrive, rebuild so they appear as variants (renderNumeric closes any
          // open palette first). One-shot: the next build has getVsBowlingTypes() set,
          // so this branch's caller-side guard won't re-fire. Skipped when the family
          // isn't offered (popup non-empty row), so a matchup/slice row fires no load.
          if (surface !== "popup" || popupMatchupOffered) ensureVsBowlingTypesLoaded();
        }
      } else {
        // vs batting hand — offered iff mapped batting hands exist in scope.
        if (isFilterAvailable("vsBattingHand", s)) {
          // R4-C naming (locked): the leaf LABEL reads "Right-hand batter" /
          // "Left-hand batter" — the preselect's stored bucket VALUE ("Right-hand
          // bat" / "Left-hand bat") is data, untouched.
          vsItems.push(matchupVsFamily("vs batting hand", [
            ["Right-hand batter", preselectMatchupVs("hand", "Right-hand bat")],
            ["Left-hand batter", preselectMatchupVs("hand", "Left-hand bat")],
          ]));
        }
      }
      // Striker batting position — matchup-only (matchupVsActive already false for
      // women, so this never surfaces there without a gender check).
      if (matchup) vsItems.push(leafSingle("strikerpos", "Batting position"));
      // Opponent-player head-to-head (T-1, owner decision 70): "subject X vs opponent
      // Y" (bowler_id when batting / batter_id when bowling). BALL-ENGINE ONLY —
      // flag-gated exactly like the Ball Ranges group (per-delivery ids are absent
      // from the innings parquets). NOT men-only: those ids exist for every delivery,
      // so it works for both genders (unlike the profile-backed vs entries above).
      // Placed beside vs bowling style / vs batting hand (decision-70 grouping).
      // T-2e: vs_opp is a ball predicate (threaded to db.query, IGNORED by
      // buildMatchupQuery), so it is withheld on a matchup-Vs row (popupSliceOffered
      // is false there) — it belongs to the per-innings-slice side of the exclusivity.
      if (ballOn && (surface !== "popup" || popupSliceOffered)) vsItems.push(leafSingle("vs_opp", "vs opponent player"));
      // No "men only" note (owner 2026-08-03): the men-only limitation on the profile-backed
      // entries is TEMPORARY — women's data arrives in the player-registry backlog phase, so this
      // group goes cross-gender soon; a "men only" label would just mislead in the meantime.
      pushGroup("Matchup (Vs)", vsItems);
    }

    // 7 ── Fielding Stats (plain mode only — no matchup grain) ─────────────────────
    // EXACTLY the two categorical ▸ slices (R2b / spec): Fielding Wicket Type and
    // Wickets by Batting Position. The former standalone count leaves (Catches /
    // Stumpings / Run-outs from parts.fielding, and Player of the Match from
    // parts.impact) are NOT offered here — the spec makes Catches/Stumpings/Run-outs
    // reachable as "Fielding Wicket Type ▸ (Caught/Run-out/Stumped) + count operator",
    // and PotM now lives in Player Profile as PotM Count. The count operator on
    // Fielding Wicket Type IS wired (R6 stale-comment fix): each variant below is a
    // normal leafMetric leaf, routing through pickMetric to the standard numeric
    // condition editor exactly like any other metric — so "Caught ≥ 10" is
    // expressible today.
    if (!matchup) {
      // Fielding Wicket Type ▸ (Wave R2c): a COUNT sub-filter (owner ruling) — each
      // kind maps to its fielding-count metric and adds a NUMERIC condition
      // ("Caught → at least → 10" = catches ≥ 10), flowing through the normal
      // condition path (buildQuery's fielding_cte join + conditionToHaving). This
      // RESTORES the Catches/Stumpings/Run-outs count filtering R2b removed as
      // standalone leaves (they belong here). Caught → catches · Run-out → run_outs ·
      // Stumped → stumpings.
      const fieldingWicketTypeFamily = () => {
        const variants = [];
        const caught = leafMetric("catches", "Caught");
        if (caught) variants.push(caught);
        // Caught & bowled (Wave R2d): now a real, distinct fielding count. R2c had to
        // disable it because `catches` folded c&b in; the data-engineer added a
        // dedicated fielding_cte.caught_and_bowled column + the `caught_and_bowled`
        // metric, so this variant maps to it and adds a NUMERIC condition ("Caught &
        // bowled → at least → 3") exactly like the other kinds. `catches` (the Caught
        // leaf) STILL includes c&b — unchanged — so Caught ≥ N and Caught & bowled ≥ N
        // measure the documented, distinct things.
        const cbowled = leafMetric("caught_and_bowled", "Caught & bowled");
        if (cbowled) variants.push(cbowled);
        const runout = leafMetric("run_outs", "Run-out");
        if (runout) variants.push(runout);
        const stumped = leafMetric("stumpings", "Stumped");
        if (stumped) variants.push(stumped);
        return variants.length ? { kind: "family", label: "Fielding Wicket Type", variants } : null;
      };
      pushGroup("Fielding Stats", [
        // Fielding Wicket Type COUNT family = Player (default lane of this group).
        fieldingWicketTypeFamily(),
        // Chunk 5: Dismissed batter's position is SCOPE — stays under the "Fielding
        // Stats" section header but routes to the Scope dropdown when laned.
        withLane(
          singleFamily("Dismissed batter's position", "fld_pos", FIELDING_POSITIONS.map((n) => [`Position ${n}`, preselectFielding("positions", n)])),
          "scope"
        ),
      ]);
    }

    return finalize(groups);
  }

  return buildPaletteGroups;
}

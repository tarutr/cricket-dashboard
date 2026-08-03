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
// taxonomy, byte-identical to the pre-extraction version. "popup" drops the 4
// fixed Player-Profile filters — Playing role, Batting hand, Bowling style,
// Regular batting position — plus PotM-as-a-filter (a pop-up row is already
// scoped to ONE player, so filtering by that player's own profile/awards is
// moot) but KEEPS Team and every Matchup (Vs) entry untouched (vs bowling
// style / vs batting hand; vs opponent player lands later, wave T-1). Every
// OTHER group — Match Details, Batting/Bowling stats, Ball Ranges, Fielding
// Stats — is identical on both surfaces; only what's listed above changes.
// "popup" is DEFINED here but not yet consumed by any mount (T-F3 scope; the
// pop-up's own mount is wave T-2).

import { effectiveNamespace, matchupVsActive, eligibleMetrics, FIELDING_POSITIONS, inningsNumberOptions } from "./state.js";
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
//     re-summed from catches+stumpings+run-outs. Boundary % Conceded (balls-based)
//     — replaced by Boundary Run %.
const DELETED_FILTER_METRIC_KEYS = new Set([
  "sr_first10", "sr_11_20", "sr_21plus",
  "wickets_per_innings", "not_out_pct", "dismissals_effected", "boundary_pct_conceded",
]);
const isDeletedFilterMetric = (m) => Boolean(m.isPhaseMetric) || DELETED_FILTER_METRIC_KEYS.has(m.key);

// Dismissal-type labels drop the leading "Out " (R5 Wave 1a, item 7: "Caught"
// not "Out Caught"). Display-only — the metric KEYS/labels in metrics.js are
// untouched; this strips the prefix at render time only. The bowling wkt_*
// labels have no "Out " prefix, so this is a no-op for them.
const stripOutPrefix = (label) => label.replace(/^Out\s+/, "");

// T-F3: the "popup" surface's Player-Profile exclusions (see file header). Any
// other surface (i.e. "leaderboard") excludes nothing — same 6 leaves as today.
const POPUP_EXCLUDED_PLAYER_PROFILE_LEAVES = new Set(["role", "hand", "bowling", "rpos", "potm_count"]);

/**
 * Bind the taxonomy builder to one surface's instance closures (its own store,
 * DOM, singleton bookkeeping). Returns `buildPaletteGroups(s, gi, {surface})`.
 */
export function createPaletteGroupsBuilder(deps) {
  const {
    isPresent, SINGLETON_TYPES,
    pickSingleton, pickMetric,
    preselectPhase, preselectFielding, preselectMatchupVs, preselectEdge, preselectInningsNumber,
    getVsBowlingTypes, ensureVsBowlingTypesLoaded,
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
   * any un-placed eligible metric to Detailed). Consequence, flagged for the owner:
   * a handful of matchup-namespace metrics that were only reachable via that
   * catch-all (Balls Faced / Dismissals in matchup_batting; Fours Conceded / Sixes
   * Conceded in matchup_bowling) are no longer offered as filters in Vs mode.
   *
   * `surface` ("leaderboard" default | "popup") — see file header. Only the
   * Player Profile group (#1) varies by surface; every other group is built
   * identically regardless.
   */
  function buildPaletteGroups(s, gi, { surface = "leaderboard" } = {}) {
    const excludeLeaf = (key) => surface === "popup" && POPUP_EXCLUDED_PLAYER_PROFILE_LEAVES.has(key);
    const ns = effectiveNamespace(s);
    const women = s.gender === "female";
    const disc = s.discipline;
    const matchup = matchupVsActive(s);
    const ballOn = ballEngineEnabled();
    const winPB = windowPhaseBallsAllowed(s);

    // R. Pos. (kind:"position") is a mode value, never a numeric condition; drop
    // it and the deleted keys before partitioning (same source as the old picker).
    const numericMetrics = eligibleMetrics(ns, s.formats)
      .filter((m) => m.kind !== "position" && !isDeletedFilterMetric(m));
    const parts = partitionFilterMetrics(numericMetrics);
    const eligibleByKey = new Map(numericMetrics.map((m) => [m.key, m]));

    const presentSingles = new Set(SINGLETON_TYPES.filter((t) => isPresent(t, s)).map((t) => t.key));
    const singlePresent = (key) => presentSingles.has(key);

    // ── item builders ──────────────────────────────────────────────────────────
    const leafMetric = (key, label) => {
      const m = eligibleByKey.get(key);
      if (!m) return null; // not eligible in this namespace/format — skip gracefully
      return { kind: "leaf", label: label ?? metricDisplayLabel(m, s.formats), run: () => pickMetric(gi, key) };
    };
    const leafSingle = (key, label, preselect = null) => ({
      kind: "leaf", label, disabled: singlePresent(key), run: () => pickSingleton(key, preselect),
    });
    const metricFamily = (label, variantDefs) => {
      const variants = variantDefs.map(([key, vlabel]) => leafMetric(key, vlabel)).filter(Boolean);
      return variants.length ? { kind: "family", label, variants } : null;
    };
    // A categorical ▸ family bound to ONE singleton: variants pre-select a value;
    // the family + variants disable once that singleton row is present.
    const singleFamily = (label, key, variantDefs) => {
      const present = singlePresent(key);
      const variants = variantDefs.map(([vlabel, preselect]) => ({
        kind: "leaf", label: vlabel, disabled: present, run: () => pickSingleton(key, preselect),
      }));
      return { kind: "family", label, disabled: present, variants };
    };
    const pushGroup = (name, items, note) => {
      const kept = items.filter(Boolean);
      if (kept.length) groups.push({ name, note, items: kept });
    };

    const groups = [];

    // 1 ── Player Profile ────────────────────────────────────────────────────────
    // T-F3: each of the 4 fixed profile leaves + PotM Count is withheld on the
    // "popup" surface via excludeLeaf (see file header); Team is never excluded.
    pushGroup("Player Profile", [
      !women && !excludeLeaf("role") ? leafSingle("role", "Playing role") : null,
      !women && disc === "batting" && !excludeLeaf("hand") ? leafSingle("hand", "Batting hand") : null,
      !women && !excludeLeaf("bowling") ? leafSingle("bowling", "Bowling style") : null,
      disc === "batting" && !excludeLeaf("rpos") ? leafSingle("rpos", "Regular batting position") : null,
      // PotM Count (R2b): the filterable count of Player-of-the-Match awards
      // (metrics.js `potm_count`), between Regular batting position and Team. The
      // old `player_of_match` (Impact section) is no longer offered as a filter.
      !excludeLeaf("potm_count") ? leafMetric("potm_count", "PotM Count") : null,
      leafSingle("team", "Team"),
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
      leafSingle("mc_stage", "Stage"),
      // "Innings order" (batted / bowled first) was replaced by Innings Number ▸
      // (Wave R2c), now live in Batting & Bowling Basic Stats. Its old plumbing
      // (mc_innings_order singleton row/editor/pill/state/clause) was fully torn
      // down in the waveR2-cleanup pass — no gap, the entry point moved.
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
        inningsNumberFamily(),
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
        // Matchup-namespace restore (Wave R2c): "Dismissals" is a matchup_batting
        // metric only — leafMetric resolves it just in matchup-batting mode (ns =
        // matchup_batting) and returns null (skipped) in plain batting. Restores a
        // filter R2b's catch-all removal dropped; "Balls Faced" above already sits
        // in this group and likewise resolves against the active namespace.
        leafMetric("dismissals", "Dismissals"),
        leafMetric("high_score", "High Score"),
        leafMetric("fifties", "50s"),
        leafMetric("hundreds", "100s"),
        leafMetric("innings_score_ge", "Innings Score ≥ N"),
      ]);
      pushGroup("Batting · Detailed Stats", [
        leafMetric("average", "Batting Average"),
        leafMetric("strike_rate", "Batting Strike Rate"),
        leafMetric("balls_per_dismissal", "Balls per Dismissal"),
        leafMetric("boundary_pct", "Boundary Ball %"),
        leafMetric("boundary_runs_pct", "Boundary Run %"),
        leafMetric("dot_pct", "Dot %"),
        leafMetric("running_sr", "NBSR"),
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
        inningsNumberFamily(),
        leafMetric("overs", "Overs"),
        leafMetric("balls", "Balls"),
        leafMetric("maidens", "Maidens"),
        leafMetric("runs_conceded", "Runs Conceded"),
        leafMetric("wickets", "Wickets"),
        // Matchup-namespace restore (Wave R2c): "Fours Conceded" / "Sixes Conceded"
        // are matchup_bowling metrics only — leafMetric resolves them in matchup-
        // bowling mode (ns = matchup_bowling) and returns null (skipped) in plain
        // bowling. Restores two filters R2b's catch-all removal dropped.
        leafMetric("fours_conceded", "Fours Conceded"),
        leafMetric("sixes_conceded", "Sixes Conceded"),
        metricFamily("Wicket Types", parts.dismissal.map((m) => [m.key, metricDisplayLabel(m, s.formats)])),
        leafMetric("best", "Best Bowling"),
        // 4-WI / 5-WI removed (R2b): the fixed exactly-4 / 5-plus haul leaves are
        // superseded by the parametrised Wicket Hauls ≥ N ▸ below. The metric defs
        // (four_wicket_hauls / five_wicket_hauls) stay in metrics.js as columns.
        leafMetric("wicket_hauls_ge", "Wicket Hauls ≥ N"),
      ]);
      pushGroup("Bowling · Detailed Stats", [
        leafMetric("average", "Bowling Average"),
        leafMetric("economy", "Economy"),
        leafMetric("strike_rate", "Bowling Strike Rate"),
        metricFamily("Extras", [["extras_wides", "Wides"], ["extras_noballs", "No-balls"]]),
        leafMetric("dot_pct", "Dot %"),
        leafMetric("boundary_runs_pct", "Boundary Run %"),
      ]);
    }

    // 5 ── Ball Ranges (ball-engine only; folds the four delivery-window entries) ─
    if (ballOn) {
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
    // Batting position) are MEN-ONLY (matchup coverage is ~0% for women). T-1 adds
    // "vs opponent player", which is GENDER-AGNOSTIC + ball-engine-gated (see below),
    // so the group can now surface on the women view too (opponent-only) when the
    // ball engine is on.
    {
      const vsItems = [];
      if (!women) {
        if (disc === "batting") {
          const vsTypes = getVsBowlingTypes() || [];
          vsItems.push(singleFamily("vs bowling style", "vs", [
            ["Pace", preselectMatchupVs("group", "Pace")],
            ["Spin", preselectMatchupVs("group", "Spin")],
            ...vsTypes.map((t) => [matchupBucketLabel(t), preselectMatchupVs("type", t)]),
          ]));
          // Fine bowling styles load lazily (matchup_batting distinct-values); once
          // they arrive, rebuild so they appear as variants (renderNumeric closes any
          // open palette first). One-shot: the next build has getVsBowlingTypes() set,
          // so this branch's caller-side guard won't re-fire.
          ensureVsBowlingTypesLoaded();
        } else {
          vsItems.push(singleFamily("vs batting hand", "vs", [
            ["Right-hand bat", preselectMatchupVs("hand", "Right-hand bat")],
            ["Left-hand bat", preselectMatchupVs("hand", "Left-hand bat")],
          ]));
        }
        if (matchup) vsItems.push(leafSingle("strikerpos", "Batting position"));
      }
      // Opponent-player head-to-head (T-1, owner decision 70): "subject X vs opponent
      // Y" (bowler_id when batting / batter_id when bowling). BALL-ENGINE ONLY —
      // flag-gated exactly like the Ball Ranges group (per-delivery ids are absent
      // from the innings parquets). NOT men-only: those ids exist for every delivery,
      // so it works for both genders (unlike the profile-backed vs entries above).
      // Placed beside vs bowling style / vs batting hand (decision-70 grouping).
      if (ballOn) vsItems.push(leafSingle("vs_opp", "vs opponent player"));
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
    // and PotM now lives in Player Profile as PotM Count. (See report: the count-
    // operator on Fielding Wicket Type is not yet wired, so "catches ≥ N" is not
    // presently expressible — flagged for the owner.)
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
        fieldingWicketTypeFamily(),
        singleFamily("Wickets by Batting Position", "fld_pos", FIELDING_POSITIONS.map((n) => [`Position ${n}`, preselectFielding("positions", n)])),
      ]);
    }

    return groups;
  }

  return buildPaletteGroups;
}

// src/playerSections.js
//
// Pure HTML builders for the player popup (B7, decision 44a). Every export
// here is side-effect-free: data in, HTML string out — src/playerPage.js owns
// fetching + DOM wiring, src/playerFilters.js owns the filters-drawer DOM;
// this module only owns composing what a section's data means visually.
// Metric vocabulary (labels, formatting, hasMetricData's no-data rule) comes
// ONLY from src/metrics.js + table.js's formatValue (SPEC §8: one metrics
// module) — nothing here redefines a metric.
//
// Split out of the old playerPage.js (which mixed rendering with fetching/
// wiring and was approaching the ~600 line ceiling) so each file stays under
// it — SPEC §8.3.

import { getMetric, DISMISSAL_KINDS, matchupBucketLabel } from "./metrics.js";
import { formatValue } from "./table.js";
import { escHtml, escAttr } from "./html.js";
import { FORMAT_BUCKETS } from "./state.js";

// ── Months (shared by the header's scope line and playerFilters.js's date
// pickers — one copy so both read "Jul 2023" identically). ─────────────────
export const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthLabel(yyyymm) {
  if (!yyyymm) return null;
  const [y, m] = yyyymm.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** Day-precision label for the popup's scope sentence (R5 Wave 2: "1 Jan
 * 2020"), as opposed to monthLabel's month-only granularity above (still used
 * by the drawer's date pickers). Reads the same "YYYY-MM-DD" values
 * state.dateFrom/dateTo always store (src/state.js's shape comment; native
 * <input type="date"> writes this shape everywhere in current code). */
export function fullDateLabel(yyyymmdd) {
  if (!yyyymmdd) return null;
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  if (!y || !m || !d) return null;
  return `${d} ${MONTH_NAMES[m - 1]} ${y}`;
}

/** Same option-list shape as filters.js's monthOptionsHTML (duplicated on
 * purpose — that one is local to the scope strip and not exported; kept in
 * sync by hand, same precedent as state.js's CONDITION_OP_SYMBOLS comment). */
export function monthOptionsHTML(minMonth, maxMonth, selected) {
  if (!minMonth || !maxMonth) return "";
  const [minY, minM] = minMonth.split("-").map(Number);
  const [maxY, maxM] = maxMonth.split("-").map(Number);
  const opts = [`<option value="">—</option>`];
  for (let y = maxY; y >= minY; y--) {
    const mFrom = y === maxY ? maxM : 12;
    const mTo = y === minY ? minM : 1;
    for (let m = mFrom; m >= mTo; m--) {
      const val = `${y}-${String(m).padStart(2, "0")}`;
      opts.push(`<option value="${val}" ${val === selected ? "selected" : ""}>${MONTH_NAMES[m - 1]} ${y}</option>`);
    }
  }
  return opts.join("");
}

// ── Identity: initials + monogram medallion + headshot ──────────────────────

export function initials(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return words.map((w) => w[0].toUpperCase()).join("") || "?";
}

/** Two-tone ink-on-panel monogram — the DELIBERATE fallback (women, unmatched
 * men, broken headshot URLs), never a bare flat circle: a panel-gradient disc
 * with an ink ring and ink initials reads as a designed crest, not a missing
 * image. `extraClass` lets headerPhotoHTML add the "only shown on <img>
 * error" modifier without a second markup shape. */
export function medallionHTML(name, extraClass = "") {
  return `<div class="player-photo__medallion ${extraClass}" aria-hidden="true">
    <span class="player-photo__initials">${escHtml(initials(name))}</span>
  </div>`;
}

/**
 * Identity header photo: a real headshot (has_real_headshot, ~1,360 players)
 * renders as a lazy <img>; every other case — no profile at all (women,
 * unmatched men — profiles are men-only, decision 21), a profile with only
 * the placeholder Cricinfo image, or a broken URL at runtime — is the
 * medallion, so "no photo" always reads as an intentional design, never a
 * broken-image glyph. The medallion sits behind the <img> as a sibling (not a
 * lazy-swapped src) so a network failure just needs a CSS class flip
 * (playerPage.js's onerror handler), no re-render.
 */
export function headerPhotoHTML(name, profile) {
  const hasPhoto = Boolean(profile && profile.has_real_headshot && profile.headshot_url);
  if (!hasPhoto) {
    return `<div class="player-photo" data-role="player-photo">${medallionHTML(name)}</div>`;
  }
  return `<div class="player-photo player-photo--has-img" data-role="player-photo">
    <img class="player-photo__img" data-role="player-photo-img" src="${escAttr(profile.headshot_url)}" alt="${escAttr(
    name
  )}" loading="lazy" decoding="async" />
    ${medallionHTML(name, "player-photo__medallion--fallback")}
  </div>`;
}

// ── Small HTML builders (unchanged shapes from the pre-B7 playerPage.js) ────

export function statCardsHTML(cards) {
  // cards: [label, metric, value][]
  return `<div class="player-stat-cards">${cards
    .map(
      ([label, metric, value]) => `
      <div class="player-stat-card">
        <div class="player-stat-card__label">${escHtml(label)}</div>
        <div class="player-stat-card__value">${escHtml(formatValue(metric, value))}</div>
      </div>`
    )
    .join("")}</div>`;
}

export function miniTableHTML(headers, bodyRows) {
  if (bodyRows.length === 0) {
    return `<p class="player-page__note">No rows in this scope.</p>`;
  }
  return `<div class="mini-table-wrap"><table class="mini-table">
    <thead><tr>${headers.map((h) => `<th>${escHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

export function sectionHTML(title, bodyHTML) {
  return `<div class="player-page__section">
    <h4 class="player-page__section-title">${escHtml(title)}</h4>
    ${bodyHTML}
  </div>`;
}

/** Thin rounded track + fill bars, sorted desc, count > 0 only. `items`: [{label, count}]. */
export function barsHTML(items, total, footnote) {
  const filtered = items.filter((it) => it.count > 0).sort((a, b) => b.count - a.count);
  const rows = filtered
    .map((it) => {
      const pct = total > 0 ? (it.count / total) * 100 : 0;
      return `<div class="fingerprint__row">
        <div class="fingerprint__label">${escHtml(it.label)}</div>
        <div class="fingerprint__track"><div class="fingerprint__fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="fingerprint__stat">${it.count.toLocaleString()} · ${pct.toFixed(1)}%</div>
      </div>`;
    })
    .join("");
  const footnoteHTML = footnote ? `<p class="player-page__footnote">${escHtml(footnote)}</p>` : "";
  return `<div class="fingerprint">${rows}</div>${footnoteHTML}`;
}

/** Plain (non-vs) how-out fingerprint: bowler- and non-bowler-credited kinds
 * alike (out_run_out included), "Not out: N of M innings" footnote — same
 * shape as pre-B7. */
export function howOutHTML(dismissals) {
  const innings = Number(dismissals.innings) || 0;
  const total = Number(dismissals.dismissals) || 0;
  const items = DISMISSAL_KINDS.map((d) => ({
    label: d.label.replace(/^Out /, ""),
    count: Number(dismissals[d.key]) || 0,
  }));
  const notOut = innings - total;
  return barsHTML(items, total, `Not out: ${notOut} of ${innings} innings`);
}

// matchup_batting's dismissal-kind columns (D4 R3 follow-up): bowler-credited
// kinds ONLY — no run-out (never bowler-credited) and no not-out math (a
// per-bowling-style "not out" isn't a real cricket quantity: being not out is
// a whole-innings property, not a per-style one). This is why the vs-scoped
// how-out gets its own caption instead of reusing howOutHTML's "Not out: N of
// M" footnote (data-layer note, see playerData.js's fetchBattingCoreVs).
const VS_DISMISSAL_KEYS = ["dis_bowled", "dis_lbw", "dis_caught", "dis_caught_and_bowled", "dis_stumped", "dis_hit_wicket"];

/** Vs-scoped how-out: same bar shape, matchup_batting's dis_* columns, and an
 * honest caption naming exactly what's being counted (task 3's required
 * wording) instead of a "Not out" figure that doesn't exist in this view. */
export function howOutVsHTML(vsRow, vsLabel) {
  const total = Number(vsRow.dismissals) || 0;
  const items = VS_DISMISSAL_KEYS.map((key) => ({
    label: getMetric(key, "matchup_batting").label.replace(/^Out /, ""),
    count: Number(vsRow[key]) || 0,
  }));
  return barsHTML(items, total, `Bowler-credited dismissals vs ${vsLabel}`);
}

export const WICKET_TYPE_KEYS = ["wkt_bowled", "wkt_lbw", "wkt_caught", "wkt_caught_and_bowled", "wkt_stumped", "wkt_hit_wicket"];

export function wicketTypesHTML(wt) {
  const items = WICKET_TYPE_KEYS.map((key) => ({ label: getMetric(key, "bowling").label, count: Number(wt[key]) || 0 }));
  return barsHTML(items, Number(wt.wickets) || 0, null);
}

export function positionsTableHTML(rows) {
  const m = {
    innings: getMetric("innings", "batting"),
    runs: getMetric("runs", "batting"),
    average: getMetric("average", "batting"),
    strike_rate: getMetric("strike_rate", "batting"),
  };
  const body = rows.map((r) => [
    escHtml(r.position),
    escHtml(formatValue(m.innings, r.innings)),
    escHtml(formatValue(m.runs, r.runs)),
    escHtml(formatValue(m.average, r.average)),
    escHtml(formatValue(m.strike_rate, r.strike_rate)),
  ]);
  return miniTableHTML(["Pos", "Inns", "Runs", "Avg", "SR"], body);
}

/** "Vs opposition" (owner task #20): shows every team type (was
 * international-only, decision 20 — that gate is REMOVED) and every
 * opponent the player has faced, no cap (decision 46's OPPOSITION_CAP=8
 * top-N-by-innings trim is REMOVED too — the popup scrolls freely now, so
 * a long list is no longer a layout problem). `rows` is always an array by
 * the time this renders (the one remaining refusal — opposition can't split
 * under a Vs/matchup scope — is handled one level up: battingGridHTML's isVs
 * branch never renders this section at all, so `rows` being empty here is
 * always the genuine "no opponents in this scope" case, which miniTableHTML
 * already renders honestly as "No rows in this scope"). */
export function oppositionSectionHTML(discipline, rows) {
  const keys = discipline === "batting" ? ["innings", "runs", "average", "strike_rate"] : ["innings", "wickets", "average", "economy"];
  const headers = discipline === "batting" ? ["Team", "Inns", "Runs", "Avg", "SR"] : ["Team", "Inns", "Wkts", "Avg", "Econ"];
  const metrics = keys.map((k) => getMetric(k, discipline));
  const body = (rows || []).map((r) => [escHtml(r.team), ...metrics.map((m) => escHtml(formatValue(m, r[m.key])))]);
  const tableHTML = miniTableHTML(headers, body);
  // Round-6 item #11: what the table COMPUTES is unchanged (still every
  // opponent, uncapped) — only how many rows are VISIBLE by default changes.
  // No rows -> miniTableHTML's own "No rows in this scope" note, no toggle
  // scaffolding needed (nothing to collapse). Real wiring (matching the
  // left column's rendered height + the Show more/less click) is DOM work
  // that belongs in JS, not this pure-string builder — see the
  // MutationObserver installed below (wireOppositionToggles), which finds
  // this markup wherever battingGridHTML/bowlingGridHTML land in the live
  // popup DOM and wires it there instead.
  if (body.length === 0) return tableHTML;
  return `<div class="vs-opposition">
    <div class="vs-opposition__scroll" data-role="vs-opposition-scroll">${tableHTML}</div>
    <button type="button" class="link-btn vs-opposition__toggle" data-role="vs-opposition-toggle" hidden>Show more</button>
  </div>`;
}

/**
 * Round-6 item #11: collapse the "Vs opposition" table to the height of the
 * left-hand column next to it (per player / per batting-vs-bowling toggle —
 * both battingGridHTML and bowlingGridHTML lay their two-col grid out as
 * `.player-page__two-col > .player-page__col` pairs, left column first), with
 * a Show more/Show less toggle for the rest. Only how many rows are VISIBLE
 * changes — the table's own computed rows (`rows` passed into
 * oppositionSectionHTML above) are untouched.
 *
 * This module's other exports are pure string builders (see file header) —
 * playerPage.js owns all DOM wiring elsewhere, but this task's owned files
 * are playerSections.js/playerFilters.js/playerData.js + styles.css only, so
 * rather than reach into playerPage.js's render call site, this installs a
 * single MutationObserver on `#player-popup-host` (a static element already
 * in index.html — present before any module script runs) that finds and
 * wires this section's markup wherever it appears: initial popup open,
 * discipline toggle, Filters-popup Apply, retry. Each toggle button is
 * marked `data-wired` once processed, so re-firing on unrelated mutations
 * inside the popup (e.g. the "find another player" search box) is a cheap
 * no-op — a genuinely NEW render replaces the DOM nodes wholesale (fresh
 * `innerHTML`), so the new button always arrives unmarked and gets rewired.
 */
function wireOppositionToggles(root) {
  root.querySelectorAll('[data-role="vs-opposition-toggle"]').forEach((toggleBtn) => {
    if (toggleBtn.dataset.wired === "true") return;
    const wrap = toggleBtn.closest(".vs-opposition");
    const scrollEl = wrap && wrap.querySelector('[data-role="vs-opposition-scroll"]');
    const grid = toggleBtn.closest(".player-page__two-col");
    const rightCol = toggleBtn.closest(".player-page__col");
    const leftCol = grid && grid.querySelector(":scope > .player-page__col");
    if (!scrollEl || !grid || !leftCol || leftCol === rightCol) return;
    toggleBtn.dataset.wired = "true";

    let expanded = false;
    function apply() {
      scrollEl.style.maxHeight = "none"; // measure the full natural height first
      const fullHeight = scrollEl.scrollHeight;
      const capHeight = Math.ceil(leftCol.getBoundingClientRect().height);
      if (fullHeight <= capHeight + 2) {
        // Already fits within (or matches) the left column — nothing to
        // collapse, so don't show a toggle that would do nothing useful.
        toggleBtn.hidden = true;
        return;
      }
      toggleBtn.hidden = false;
      scrollEl.style.maxHeight = expanded ? "none" : `${capHeight}px`;
      toggleBtn.textContent = expanded ? "Show less" : "Show more";
    }
    toggleBtn.addEventListener("click", () => {
      expanded = !expanded;
      apply();
    });
    apply();
  });
}

// Installed once, at module load — see wireOppositionToggles' doc comment for
// why this lives here (a MutationObserver) instead of a call from
// playerPage.js's render site. `#player-popup-host` is a static empty <div>
// in index.html (present before any module script executes), so this never
// races the DOM being ready.
(function installOppositionToggleObserver() {
  const host = typeof document !== "undefined" && document.getElementById("player-popup-host");
  if (!host) return; // defensive only — should always exist per index.html
  const observer = new MutationObserver(() => wireOppositionToggles(host));
  observer.observe(host, { childList: true, subtree: true });
})();

/** A mini-table with its own small label above it, for grouping two tables under one section. */
export function subTableHTML(title, headers, bodyRows) {
  return `<div class="matchup__subtable">
    <p class="matchup__subtable-title">${escHtml(title)}</p>
    ${miniTableHTML(headers, bodyRows)}
  </div>`;
}

/**
 * Coverage-or-nothing gate (SPEC_ADDENDUM D4.3, decision 21): matchup data is
 * missing for every women's player and some men, so we never show a bucket
 * table without first stating what fraction of balls carry style/hand data —
 * and if that fraction is zero, we show a greyed note and NO tables at all.
 */
export function matchupCoverageLine(label, noun, coverage) {
  const total = Number(coverage?.total) || 0;
  const mapped = Number(coverage?.mapped) || 0;
  if (total === 0 || mapped === 0) return null;
  const pct = ((mapped / total) * 100).toFixed(1);
  return `<p class="matchup__coverage">${escHtml(label)} covers ${mapped.toLocaleString()} of ${total.toLocaleString()} balls ${escHtml(
    noun
  )} (${pct}%).</p>`;
}

const BATTING_MATCHUP_KEYS = ["innings", "balls", "runs", "strike_rate", "average", "dismissals"];
const BATTING_MATCHUP_HEADERS = ["Bucket", "Inns", "Balls", "Runs", "SR", "Avg", "Out"];
// Coverage-breakdown wave: the COARSE "Vs pace and spin" table gains a
// right-most composition-% column (the fine "Vs bowling type" table does NOT —
// it keeps BATTING_MATCHUP_HEADERS). The %% is each bucket's balls faced as a
// share of the player's TOTAL balls faced in scope (matchups.coverage.total) —
// the SAME number as the leaderboard's "Pace BF %" / "Spin BF %" columns.
const BATTING_COARSE_HEADERS = [...BATTING_MATCHUP_HEADERS, "% BF"];
// Coarse bucket -> the matchup_batting composition metric it corresponds to
// (used only for identical pct1 formatting — the numeric value is computed
// here from balls ÷ total, same as the leaderboard column).
const COARSE_COMP_KEY = { Pace: "comp_pace", Spin: "comp_spin" };
// Coarse buckets always read Pace before Spin, then '(unmapped)' last (its
// COARSE_ORDER fallback is `?? 2`), regardless of which has more balls.
const COARSE_ORDER = { Pace: 0, Spin: 1 };
// The '(unmapped)' coarse bucket renders as an "Uncategorised" row (the third
// row, per COARSE_ORDER above); Pace/Spin pass through as their own labels.
const COARSE_LABEL = { "(unmapped)": "Uncategorised" };

/** One composition-% cell: `balls` as a share of the player's TOTAL balls
 * (`total`), formatted through the composition metric `compKey` in `ns` so it
 * reads identically to the leaderboard's matching column. `total > 0` is
 * guaranteed by the caller's coverage gate; the NULL branch is defensive. */
function compositionPctCell(ns, compKey, balls, total) {
  const m = getMetric(compKey, ns);
  const value = total > 0 ? (Number(balls) / total) * 100 : null;
  return escHtml(formatValue(m, value));
}

// Fine-breakdown bowling_type -> coarse group, for the "vs bowling type"
// table (owner note 11, fix round: group Pace then Spin with subheadings).
// The fine query has no per-row bowling_group column to key off of (see
// playerData.js's fetchBattingMatchups — fineSql selects `bowling_type AS
// bucket` only, unlike coarseSql's `bowling_group AS bucket`), so this is a
// static label map, not data-driven. Same 9 named styles + same pace/spin
// split as table.js's BOWLING_TYPE_PREFERENCE / drawer.js's BOWLING_TYPE_ORDER
// (kept in sync by hand — those two live in files outside this task's scope,
// same "duplicated on purpose" precedent as this file's own monthOptionsHTML
// comment above).
const FINE_BOWLING_GROUP = {
  Fast: "Pace",
  "Fast-medium": "Pace",
  "Medium-fast": "Pace",
  Medium: "Pace",
  "Slow-medium": "Pace",
  "Off-spin": "Spin",
  "Leg-spin": "Spin",
  "Slow left-arm orthodox": "Spin",
  "Left-arm wrist-spin": "Spin",
};

/** Coarse group for one fine bowling_type value. Bare/unspecified bowlers
 * already carry the literal bucket "Pace"/"Spin" (decision 24 — see
 * matchupBucketLabel above) and pass straight through. Anything genuinely
 * unrecognised (shouldn't occur: the vocabulary above is closed, same
 * assumption table.js's own bowling-type ordering makes) falls back to a
 * name-based guess rather than silently dropping out of both groups. */
function fineBowlingGroup(bucket) {
  if (bucket === "Pace" || bucket === "Spin") return bucket;
  if (FINE_BOWLING_GROUP[bucket]) return FINE_BOWLING_GROUP[bucket];
  return /spin|orthodox|wrist/i.test(bucket) ? "Spin" : "Pace";
}

/** Subheading row spanning every column — marks the start of a group WITHIN
 * one table body (owner note 11: Pace then Spin inside the SAME "vs bowling
 * type" table, not two separate tables). */
function groupHeadingRowHTML(label, colCount) {
  return `<tr class="mini-table__group-row"><td colspan="${colCount}">${escHtml(label)}</td></tr>`;
}

/** Same title-then-table shape as subTableHTML, but for the fine "vs bowling
 * type" breakdown specifically: rows are grouped ALL-pace-then-ALL-spin with
 * a subheading row before each non-empty group (owner note 11, fix round).
 * Order WITHIN a group is untouched (balls DESC, from the SQL — Array#filter
 * is stable, so partitioning by group never reorders rows within it). A
 * group with no rows in this scope gets no heading (§8.4: never state a
 * heading over zero rows). `entries`: [{bucket, cells}] — `bucket` is the RAW
 * fine value (for classification), `cells` the already-escaped/formatted row
 * (for display, label already run through matchupBucketLabel by the caller). */
function fineBowlingTypeSectionHTML(title, headers, entries) {
  if (entries.length === 0) {
    return `<div class="matchup__subtable">
      <p class="matchup__subtable-title">${escHtml(title)}</p>
      ${miniTableHTML(headers, [])}
    </div>`;
  }
  const pace = entries.filter((e) => fineBowlingGroup(e.bucket) === "Pace");
  const spin = entries.filter((e) => fineBowlingGroup(e.bucket) === "Spin");
  const colCount = headers.length;
  const rowsHTML = (list) => list.map((e) => `<tr>${e.cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  const groupHTML = (label, list) => (list.length ? groupHeadingRowHTML(label, colCount) + rowsHTML(list) : "");
  const bodyHTML = `${groupHTML("Pace", pace)}${groupHTML("Spin", spin)}`;
  return `<div class="matchup__subtable">
    <p class="matchup__subtable-title">${escHtml(title)}</p>
    <div class="mini-table-wrap"><table class="mini-table">
      <thead><tr>${headers.map((h) => `<th>${escHtml(h)}</th>`).join("")}</tr></thead>
      <tbody>${bodyHTML}</tbody>
    </table></div>
  </div>`;
}

export function battingMatchupsHTML(matchups) {
  const coverageHTML = matchupCoverageLine("Matchup data", "faced", matchups.coverage);
  if (!coverageHTML) {
    return `<p class="player-page__note player-page__note--muted">No bowling-style data in this scope.</p>`;
  }
  const metrics = BATTING_MATCHUP_KEYS.map((k) => getMetric(k, "matchup_batting"));
  const rowFor = (label, r) => [escHtml(label), ...metrics.map((m) => escHtml(formatValue(m, r[m.key])))];

  const total = Number(matchups.coverage?.total) || 0;
  const coarse = [...matchups.coarse].sort((a, b) => (COARSE_ORDER[a.bucket] ?? 2) - (COARSE_ORDER[b.bucket] ?? 2));
  // Coarse rows gain the composition-% cell; the FINE rows (below) do NOT.
  // '(unmapped)' renders as the "Uncategorised" third row, its % via comp_uncat.
  const coarseRows = coarse.map((r) => [
    ...rowFor(COARSE_LABEL[r.bucket] ?? r.bucket, r),
    compositionPctCell("matchup_batting", COARSE_COMP_KEY[r.bucket] ?? "comp_uncat", r.balls, total),
  ]);
  const fineEntries = matchups.fine.map((r) => ({ bucket: r.bucket, cells: rowFor(matchupBucketLabel(r.bucket), r) }));

  return `${coverageHTML}${subTableHTML("Vs pace and spin", BATTING_COARSE_HEADERS, coarseRows)}${fineBowlingTypeSectionHTML(
    "Vs bowling type",
    BATTING_MATCHUP_HEADERS,
    fineEntries
  )}`;
}

const BOWLING_MATCHUP_KEYS = ["innings", "balls", "runs_conceded", "wickets", "economy", "average", "strike_rate"];
const BOWLING_MATCHUP_HEADERS = ["Bucket", "Inns", "Balls", "Runs", "Wkts", "Econ", "Avg", "SR"];
// Coverage-breakdown wave: right-most composition-% column — each hand's balls
// bowled as a share of the player's TOTAL balls bowled in scope (same number
// as the leaderboard's "RHB %" / "LHB %" columns).
const BOWLING_HAND_HEADERS = [...BOWLING_MATCHUP_HEADERS, "% balls"];
const HAND_COMP_KEY = { "Right-hand bat": "comp_rhb", "Left-hand bat": "comp_lhb" };
// '(unmapped)' renders as an "Uncategorised" row (forced last below); the two
// named hands read as "Right-handers" / "Left-handers".
const HAND_LABELS = { "Right-hand bat": "Right-handers", "Left-hand bat": "Left-handers", "(unmapped)": "Uncategorised" };

export function bowlingMatchupsHTML(matchups) {
  const coverageHTML = matchupCoverageLine("Matchup data", "bowled", matchups.coverage);
  if (!coverageHTML) {
    return `<p class="player-page__note player-page__note--muted">No batting-hand data in this scope.</p>`;
  }
  const metrics = BOWLING_MATCHUP_KEYS.map((k) => getMetric(k, "matchup_bowling"));
  const total = Number(matchups.coverage?.total) || 0;
  // Uncategorised ('(unmapped)') always renders last; RHB/LHB keep their SQL
  // balls-DESC order (Array#sort is stable, so this only moves '(unmapped)').
  const hands = [...matchups.hands].sort(
    (a, b) => (a.bucket === "(unmapped)" ? 1 : 0) - (b.bucket === "(unmapped)" ? 1 : 0)
  );
  const rows = hands.map((r) => [
    escHtml(HAND_LABELS[r.bucket] ?? r.bucket),
    ...metrics.map((m) => escHtml(formatValue(m, r[m.key]))),
    compositionPctCell("matchup_bowling", HAND_COMP_KEY[r.bucket] ?? "comp_uncat", r.balls, total),
  ]);
  return `${coverageHTML}${miniTableHTML(BOWLING_HAND_HEADERS, rows)}`;
}

// ── Honest refusal rendering (B7 overlay) ────────────────────────────────────
// A section fetcher returns `{ unsupported: [dims] }` when the popup's
// filters-drawer overlay asked for something that source can't honor (see
// playerData.js's PLAYER_SECTION_SUPPORT / applyOverlay). We NEVER show a
// partially-filtered number — the section greys out in place with a plain-
// English note instead, exactly like the leaderboard matchup mode's coverage
// gate greys a whole bucket table rather than show a misleading partial one.
const DIM_LABELS = { date: "date range", positions: "batting position", opposition: "opposition", vs: "Vs" };

export function dimDisplayLabel(dim) {
  return DIM_LABELS[dim] || dim;
}

export function unsupportedNoteHTML(sectionTitle, dims) {
  const dimLabel = (dims || []).map(dimDisplayLabel).join(" or ");
  return `<p class="player-page__note player-page__note--muted">Can't split "${escHtml(sectionTitle)}" by ${escHtml(
    dimLabel
  )} here.</p>`;
}

/** Wrap a section's fetch result: `{unsupported}` greys in place, otherwise
 * `renderFn(result)` builds the real content. One call site for every
 * section that can be refused by the filters-drawer overlay. */
export function sectionOrUnsupported(title, result, renderFn) {
  if (result && Array.isArray(result.unsupported)) {
    return sectionHTML(title, unsupportedNoteHTML(title, result.unsupported));
  }
  return sectionHTML(title, renderFn(result));
}

/** Whole-tab refusal (bowling only in practice): the overlay carries a dim
 * that NO section on this tab can honor at all (e.g. a Positions/Vs value
 * set from the Batting tab, where bowling's own core has no position/vs
 * concept — PLAYER_SECTION_SUPPORT's bowling.core says so). Greys the entire
 * tab with one note rather than every section repeating itself. */
export function wholeTabUnsupportedHTML(tabLabel, dims) {
  const dimLabel = (dims || []).map(dimDisplayLabel).join(" and ");
  return `<p class="player-page__note player-page__note--muted">${escHtml(
    tabLabel
  )} can't be shown with a ${escHtml(dimLabel)} filter active — remove it (Filters, or the pills above) to see this tab.</p>`;
}

// ── Scope line + overlay pills ───────────────────────────────────────────────

// R5 Wave 2: these three strings feed directly into scopeLine's "Data for...
// (team type)" sentence below — not a general-purpose "cricket" noun phrase
// anymore (that was the pre-R5-Wave-2 wording), so keep them short nouns.
// Local to this file only (grepped repo-wide before this change) — safe to
// repurpose without touching any other consumer.
export const TEAM_TYPE_LABELS = { international: "International", club: "Domestic", both: "International + Domestic" };

/** Honest scope sentence (R5 Wave 2 reword, owner point 3): a single plain
 * sentence — "Data for [format] ([team type]) from [start date] to [end
 * date]" — replacing the old pipe-separated fragments-plus-caveat shape.
 * `state` is whichever scope the popup is actually using: playerPage.js's
 * effectiveState() (the table's live scope for a table-row popup, or the
 * frozen fixedScopeState for a header-search popup — see that file's header
 * comment) — so the same sentence shape is honest for BOTH entry paths
 * without needing its own caveat/suffix per path any more (the old
 * `fixedDefault`-keyed suffix this replaced is gone).
 *
 * [format]: joins the state's format bucket(s) by their FORMAT_BUCKETS
 * `.label` (never hardcoded — SPEC §8.2, one metrics/vocabulary source),
 * ordered by FORMAT_BUCKETS' own order rather than whatever order
 * state.formats happens to hold. [team type]: TEAM_TYPE_LABELS above.
 * [start]/[end]: fullDateLabel's day-precision "1 Jan 2020" reading of
 * state.dateFrom/dateTo directly (both always populated by the time a
 * popup is open to render this — src/state.js never lets a search run with
 * dateFrom unset, and buildFixedScopeState always fills both).
 *
 * The overlay's own extra narrowing (date/positions/opposition/vs) is
 * intentionally NOT folded into this sentence any more — it already has its
 * own removable-pills row directly below (overlayPillsHTML, rendered by
 * playerPage.js's renderScopeArea right after this line), so restating it
 * here would just duplicate that UI, not add honesty this sentence needs.
 */
export function scopeLine(state, overlay) {
  const formatLabel = FORMAT_BUCKETS.filter((b) => state.formats && state.formats.includes(b.key))
    .map((b) => b.label)
    .join(", ");
  const teamTypeStr = TEAM_TYPE_LABELS[state.teamType] || state.teamType || "";
  const fromLbl = fullDateLabel(state.dateFrom);
  const toLbl = fullDateLabel(state.dateTo);
  let dateStr = "";
  if (fromLbl && toLbl) dateStr = ` from ${fromLbl} to ${toLbl}`;
  else if (fromLbl) dateStr = ` from ${fromLbl}`;
  else if (toLbl) dateStr = ` through ${toLbl}`;
  return `Data for ${formatLabel || "all formats"} (${teamTypeStr})${dateStr}`;
}

// ── Discipline grid composition (re-composition of existing sections) ───────
// Moved out of playerPage.js (which owns fetching/wiring) to keep that file
// under SPEC §8.3's ~600-line ceiling — these are still pure data-in/HTML-out
// builders, just discipline-specific ones, same category as everything else
// in this file.

/** Owner's red-ball exception: Red Ball (Test/MDM) scopes swap SR for balls-per-dismissal.
 *  R5: format buckets collapsed to Red Ball / 50 Over / T20, so this now keys on the
 *  "Red Ball" bucket rather than the retired "Test"/"MDM" bucket keys. */
export function isRedBallOnly(state) {
  return state.formats.length > 0 && state.formats.every((f) => f === "Red Ball");
}

/** Normalizes fetchBattingCore's two possible shapes (plain row, or the
 * `vs`-scoped composite from fetchBattingCoreVs) into one shape every
 * downstream renderer reads the same way. */
export function normalizeBattingCore(core) {
  if (!core) return null;
  if (core.source === "matchup_batting") return core; // { vs, source, coverage, summary, howout, progression }
  return { source: "batting", vs: null, coverage: null, summary: core, howout: core, progression: core };
}

export function battingGridHTML(state, coreNorm, extra) {
  const summary = coreNorm?.summary;
  const isVs = coreNorm?.source === "matchup_batting";
  if (!summary || Number(summary.innings) === 0) {
    return isVs
      ? `<p class="player-page__note">No innings vs ${escHtml(coreNorm.vs)} in this scope.</p>`
      : `<p class="player-page__note">No batting in this scope.</p>`;
  }
  const redBall = isRedBallOnly(state);
  let heroCardsHTML;
  let coverageHTML = "";
  if (isVs) {
    // matchup_batting has no high_score column — the plain page's 5th tile
    // (HS) has no analog here, so Boundary % takes its place (flagged: a
    // judgment call, see the final report).
    const dismissals = Number(summary.dismissals) || 0;
    const bpd = dismissals > 0 ? Number(summary.balls) / dismissals : null;
    heroCardsHTML = statCardsHTML([
      ["Inns", getMetric("innings", "matchup_batting"), summary.innings],
      ["Runs", getMetric("runs", "matchup_batting"), summary.runs],
      ["Avg", getMetric("average", "matchup_batting"), summary.average],
      redBall
        ? ["BPD", getMetric("balls_per_dismissal", "matchup_batting"), bpd]
        : ["SR", getMetric("strike_rate", "matchup_batting"), summary.strike_rate],
      ["Bdry %", getMetric("boundary_pct", "matchup_batting"), summary.boundary_pct],
    ]);
    coverageHTML = matchupCoverageLine("Matchup data", "faced", coreNorm.coverage) || "";
  } else {
    const srKey = redBall ? "balls_per_dismissal" : "strike_rate";
    const srLabel = redBall ? "BPD" : "SR";
    heroCardsHTML = statCardsHTML([
      ["Inns", getMetric("innings", "batting"), summary.innings],
      ["Runs", getMetric("runs", "batting"), summary.runs],
      ["Avg", getMetric("average", "batting"), summary.average],
      [srLabel, getMetric(srKey, "batting"), summary[srKey]],
      ["HS", getMetric("high_score", "batting"), summary.high_score],
    ]);
  }

  // "Wicket Type" (renamed from "How out", owner decision 46). Under a Vs
  // bucket this is the ONLY per-section content besides the tiles above that
  // can still split by Vs (it switches source to matchup_batting — see
  // fetchBattingCoreVs) — its title adopts the vs label too, so the honesty
  // the bars' own footnote already states ("Bowler-credited dismissals vs X")
  // is visible in the section heading, not just the caption underneath.
  const wicketTypeTitle = isVs ? `Wicket Type — bowler-credited vs ${coreNorm.vs}` : "Wicket Type";
  const howOutBody = isVs ? howOutVsHTML(coreNorm.howout, coreNorm.vs) : howOutHTML(coreNorm.howout);

  let bodyHTML;
  if (isVs) {
    // Position / opposition / progression can't split by Vs at all (see
    // PLAYER_SECTION_SUPPORT — all three are `false` for the `vs` dim) —
    // owner decision 46 hides them outright instead of greying them out with
    // "Can't split X by Vs here", so only what's actually splittable renders:
    // the tiles above, and Wicket Type here. No two-col grid, no dead gap
    // where the hidden sections used to be.
    bodyHTML = sectionHTML(wicketTypeTitle, howOutBody);
  } else {
    // "Progressive Scoring" (renamed from "Scoring by balls faced", decision
    // 46). Only reached when !isVs, where coreNorm.progression is always the
    // plain core row (never the `{unsupported}` shape — that only exists on
    // the isVs branch of fetchBattingCoreVs, handled above instead) — no
    // refusal check needed here.
    const progressionBody = statCardsHTML([
      ["SR, balls 1–10", getMetric("sr_first10", "batting"), coreNorm.progression.sr_first10],
      ["SR, balls 11–20", getMetric("sr_11_20", "batting"), coreNorm.progression.sr_11_20],
      ["SR, balls 21+", getMetric("sr_21plus", "batting"), coreNorm.progression.sr_21plus],
    ]);
    // Column rebalance (decision 46): LEFT = position table, Wicket Type,
    // Progressive Scoring stacked top-to-bottom; RIGHT = Vs opposition, now
    // showing every opponent, uncapped (owner task #20 — the popup scrolls
    // freely). Matchups (below, outside this grid) is unchanged.
    const leftColHTML = `${sectionOrUnsupported("By batting position", extra.positions, positionsTableHTML)}
      ${sectionHTML(wicketTypeTitle, howOutBody)}
      ${sectionHTML("Progressive Scoring", progressionBody)}`;
    const rightColHTML = sectionOrUnsupported("Vs opposition", extra.opposition, (rows) =>
      oppositionSectionHTML("batting", rows)
    );
    bodyHTML = `<div class="player-page__two-col">
      <div class="player-page__col">${leftColHTML}</div>
      <div class="player-page__col">${rightColHTML}</div>
    </div>`;
  }

  const matchupsHTML = sectionOrUnsupported("Matchups", extra.matchups, battingMatchupsHTML);

  return `${heroCardsHTML}${coverageHTML}${bodyHTML}${matchupsHTML}`;
}

/** Bowling's tight grid has one fewer row than batting's — bowling has no
 * by-position/how-out/progression analog, only wicket types + opposition +
 * matchups (flagged: the task's 4-row description was written with batting's
 * shape in mind; adapted here to bowling's actual 4 existing sections). */
export function bowlingGridHTML(state, core, extra) {
  if (core && Array.isArray(core.unsupported)) {
    return wholeTabUnsupportedHTML("Bowling", core.unsupported);
  }
  if (!core || Number(core.innings) === 0) {
    return `<p class="player-page__note">No bowling in this scope.</p>`;
  }
  const heroCardsHTML = statCardsHTML([
    ["Inns", getMetric("innings", "bowling"), core.innings],
    ["Wkts", getMetric("wickets", "bowling"), core.wickets],
    ["Avg", getMetric("average", "bowling"), core.average],
    ["Econ", getMetric("economy", "bowling"), core.economy],
    ["SR", getMetric("strike_rate", "bowling"), core.strike_rate],
    ["BBI", getMetric("best", "bowling"), core.best],
  ]);
  // Same helper as batting's Vs-opposition table, now uncapped for the same
  // reason (owner task #20 — the popup scrolls freely, so a long opponent
  // list is no longer trimmed).
  const twoColA = `<div class="player-page__two-col">
    <div class="player-page__col">${sectionHTML("Wicket types", wicketTypesHTML(core))}</div>
    <div class="player-page__col">${sectionOrUnsupported("Vs opposition", extra.opposition, (rows) =>
      oppositionSectionHTML("bowling", rows)
    )}</div>
  </div>`;
  const matchupsHTML = sectionOrUnsupported("Matchups", extra.matchups, bowlingMatchupsHTML);
  return `${heroCardsHTML}${twoColA}${matchupsHTML}`;
}

/** One removable pill per active overlay dimension, `data-dim` naming which
 * overlay key a click should clear, plus a "Reset filters" link clearing all
 * of them at once. Returns "" when the overlay is empty (no pills row at
 * all — matches the main app's pills.js precedent of hiding the whole row). */
export function overlayPillsHTML(overlay) {
  if (!overlay) return "";
  const entries = [];
  if (overlay.dateFrom || overlay.dateTo) {
    const f = monthLabel(overlay.dateFrom);
    const t = monthLabel(overlay.dateTo);
    entries.push({ dim: "date", label: f && t ? `${f} – ${t}` : f ? `From ${f}` : `Through ${t}` });
  }
  if (overlay.positions && overlay.positions.length) {
    const sorted = [...overlay.positions].sort((a, b) => a - b);
    entries.push({ dim: "positions", label: `Batting at ${sorted.join(", ")}` });
  }
  if (overlay.opposition) entries.push({ dim: "opposition", label: `Against ${overlay.opposition}` });
  if (overlay.vs) entries.push({ dim: "vs", label: `Vs ${overlay.vs}` });
  if (entries.length === 0) return "";
  return `<div class="pills-row player-page__filter-pills">${entries
    .map(
      (e) =>
        `<span class="pill">${escHtml(e.label)} <button type="button" class="pill__x" data-dim="${e.dim}" aria-label="Remove filter">&times;</button></span>`
    )
    .join(
      ""
    )}<button type="button" class="link-btn player-page__reset-filters" data-role="reset-player-filters">Reset filters</button></div>`;
}

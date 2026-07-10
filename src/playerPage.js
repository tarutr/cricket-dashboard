// src/playerPage.js
//
// Players destination (R2, decision 29): a search-first single-player page.
// All SQL lives in src/playerData.js — this module only composes its results
// into HTML. Metric vocabulary (labels, formatting) comes ONLY from
// src/metrics.js + table.js's formatValue (SPEC §8: one metrics module).
//
// Page scope is REDUCED to Format + Date range + Team type (see playerData.js
// header) — gender and every drawer/leaderboard filter are inert here, and the
// scope line always says so, honestly (§8.4).

import {
  searchPlayers,
  fetchProfile,
  fetchBattingCore,
  fetchBattingPositions,
  fetchBattingOpposition,
  fetchBattingMatchups,
  fetchBowlingCore,
  fetchBowlingOpposition,
  fetchBowlingMatchups,
} from "./playerData.js";
import { getMetric, DISMISSAL_KINDS, matchupBucketLabel } from "./metrics.js";
import { formatValue } from "./table.js";
import { escHtml, escAttr } from "./html.js";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(yyyymm) {
  if (!yyyymm) return null;
  const [y, m] = yyyymm.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

const TEAM_TYPE_LABELS = { international: "International cricket", club: "Club cricket", both: "All cricket" };

/** Scope key: refetch only when the player OR this tuple changes (playerData.js's scope). */
function scopeKeyFor(state) {
  return JSON.stringify([state.formats, state.dateFrom, state.dateTo, state.teamType]);
}

/** Owner's red-ball exception: Test/MDM-only scopes swap SR for balls-per-dismissal. */
function isRedBallOnly(state) {
  return state.formats.length > 0 && state.formats.every((f) => f === "Test" || f === "MDM");
}

function initials(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  return words.map((w) => w[0].toUpperCase()).join("") || "?";
}

/** Honest scope sentence: only the three filters that apply on this page, plus the fixed caveat. */
function scopeLine(state) {
  const parts = [];
  if (state.formats && state.formats.length) parts.push(state.formats.join(" + "));
  const fromLbl = monthLabel(state.dateFrom);
  const toLbl = monthLabel(state.dateTo);
  if (fromLbl && toLbl) parts.push(`${fromLbl} – ${toLbl}`);
  else if (toLbl) parts.push(`through ${toLbl}`);
  else if (fromLbl) parts.push(`from ${fromLbl}`);
  const teamTypeStr = TEAM_TYPE_LABELS[state.teamType];
  if (teamTypeStr) parts.push(teamTypeStr);
  const suffix = "leaderboard-only filters don't apply here";
  return parts.length ? `${parts.join(" · ")} · ${suffix}` : suffix;
}

// ── Small HTML builders ──────────────────────────────────────────────────────

function statCardsHTML(cards) {
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

function miniTableHTML(headers, bodyRows) {
  if (bodyRows.length === 0) {
    return `<p class="player-page__note">No rows in this scope.</p>`;
  }
  return `<div class="mini-table-wrap"><table class="mini-table">
    <thead><tr>${headers.map((h) => `<th>${escHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
  </table></div>`;
}

function sectionHTML(title, bodyHTML) {
  return `<div class="player-page__section">
    <h4 class="player-page__section-title">${escHtml(title)}</h4>
    ${bodyHTML}
  </div>`;
}

function blockWrapperHTML(title, bodyHTML) {
  return `<div class="player-page__block">
    <h3 class="player-page__block-title">${escHtml(title)}</h3>
    ${bodyHTML}
  </div>`;
}

/** Thin rounded track + fill bars, sorted desc, count > 0 only. `items`: [{label, count}]. */
function barsHTML(items, total, footnote) {
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

function howOutHTML(dismissals) {
  const innings = Number(dismissals.innings) || 0;
  const total = Number(dismissals.dismissals) || 0;
  const items = DISMISSAL_KINDS.map((d) => ({
    label: d.label.replace(/^Out /, ""),
    count: Number(dismissals[d.key]) || 0,
  }));
  const notOut = innings - total;
  return barsHTML(items, total, `Not out: ${notOut} of ${innings} innings`);
}

const WICKET_TYPE_KEYS = ["wkt_bowled", "wkt_lbw", "wkt_caught", "wkt_caught_and_bowled", "wkt_stumped", "wkt_hit_wicket"];
function wicketTypesHTML(wt) {
  const items = WICKET_TYPE_KEYS.map((key) => ({ label: getMetric(key, "bowling").label, count: Number(wt[key]) || 0 }));
  return barsHTML(items, Number(wt.wickets) || 0, null);
}

function positionsTableHTML(rows) {
  const m = { innings: getMetric("innings", "batting"), runs: getMetric("runs", "batting"), average: getMetric("average", "batting"), strike_rate: getMetric("strike_rate", "batting") };
  const body = rows.map((r) => [
    escHtml(r.position),
    escHtml(formatValue(m.innings, r.innings)),
    escHtml(formatValue(m.runs, r.runs)),
    escHtml(formatValue(m.average, r.average)),
    escHtml(formatValue(m.strike_rate, r.strike_rate)),
  ]);
  return miniTableHTML(["Pos", "Inns", "Runs", "Avg", "SR"], body);
}

/** "Vs opposition" is international-only (decision 20); `rows` is null when not fetched. */
function oppositionSectionHTML(state, discipline, rows) {
  if (state.teamType !== "international") {
    return `<p class="player-page__note player-page__note--muted">Opposition splits are international-only for now.</p>`;
  }
  const keys = discipline === "batting" ? ["innings", "runs", "average", "strike_rate"] : ["innings", "wickets", "average", "economy"];
  const headers = discipline === "batting" ? ["Team", "Inns", "Runs", "Avg", "SR"] : ["Team", "Inns", "Wkts", "Avg", "Econ"];
  const metrics = keys.map((k) => getMetric(k, discipline));
  const body = (rows || []).map((r) => [escHtml(r.team), ...metrics.map((m) => escHtml(formatValue(m, r[m.key])))]);
  return miniTableHTML(headers, body);
}

/** A mini-table with its own small label above it, for grouping two tables under one section. */
function subTableHTML(title, headers, bodyRows) {
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
function matchupCoverageLine(label, noun, coverage) {
  const total = Number(coverage?.total) || 0;
  const mapped = Number(coverage?.mapped) || 0;
  if (total === 0 || mapped === 0) return null;
  const pct = ((mapped / total) * 100).toFixed(1);
  return `<p class="matchup__coverage">${escHtml(label)} covers ${mapped.toLocaleString()} of ${total.toLocaleString()} balls ${escHtml(noun)} (${pct}%).</p>`;
}

const BATTING_MATCHUP_KEYS = ["innings", "balls", "runs", "strike_rate", "average", "dismissals"];
const BATTING_MATCHUP_HEADERS = ["Bucket", "Inns", "Balls", "Runs", "SR", "Avg", "Out"];
// Coarse buckets always read Pace before Spin, regardless of which has more balls.
const COARSE_ORDER = { Pace: 0, Spin: 1 };

function battingMatchupsHTML(matchups) {
  const coverageHTML = matchupCoverageLine("Style data", "faced", matchups.coverage);
  if (!coverageHTML) {
    return sectionHTML("Matchups", `<p class="player-page__note player-page__note--muted">No bowling-style data in this scope.</p>`);
  }
  const metrics = BATTING_MATCHUP_KEYS.map((k) => getMetric(k, "matchup_batting"));
  const rowFor = (label, r) => [escHtml(label), ...metrics.map((m) => escHtml(formatValue(m, r[m.key])))];

  const coarse = [...matchups.coarse].sort((a, b) => (COARSE_ORDER[a.bucket] ?? 2) - (COARSE_ORDER[b.bucket] ?? 2));
  const coarseRows = coarse.map((r) => rowFor(r.bucket, r));
  const fineRows = matchups.fine.map((r) => rowFor(matchupBucketLabel(r.bucket), r));

  const tablesHTML = `${subTableHTML("Vs pace and spin", BATTING_MATCHUP_HEADERS, coarseRows)}${subTableHTML(
    "Vs bowling type",
    BATTING_MATCHUP_HEADERS,
    fineRows
  )}`;
  return sectionHTML("Matchups", `${coverageHTML}${tablesHTML}`);
}

const BOWLING_MATCHUP_KEYS = ["innings", "balls", "runs_conceded", "wickets", "economy", "average", "strike_rate"];
const BOWLING_MATCHUP_HEADERS = ["Bucket", "Inns", "Balls", "Runs", "Wkts", "Econ", "Avg", "SR"];
const HAND_LABELS = { "Right-hand bat": "Right-handers", "Left-hand bat": "Left-handers" };

function bowlingMatchupsHTML(matchups) {
  const coverageHTML = matchupCoverageLine("Batting-hand data", "bowled", matchups.coverage);
  if (!coverageHTML) {
    return sectionHTML("Vs left- and right-handers", `<p class="player-page__note player-page__note--muted">No batting-hand data in this scope.</p>`);
  }
  const metrics = BOWLING_MATCHUP_KEYS.map((k) => getMetric(k, "matchup_bowling"));
  const rows = matchups.hands.map((r) => [
    escHtml(HAND_LABELS[r.bucket] ?? r.bucket),
    ...metrics.map((m) => escHtml(formatValue(m, r[m.key]))),
  ]);
  return sectionHTML("Vs left- and right-handers", `${coverageHTML}${miniTableHTML(BOWLING_MATCHUP_HEADERS, rows)}`);
}

function battingBlockHTML(state, summary, extra) {
  if (!summary || Number(summary.innings) === 0) {
    return blockWrapperHTML("Batting", `<p class="player-page__note">No batting in this scope.</p>`);
  }
  const redBall = isRedBallOnly(state);
  const srKey = redBall ? "balls_per_dismissal" : "strike_rate";
  const srLabel = redBall ? "BPD" : "SR";
  const cardsHTML = statCardsHTML([
    ["Inns", getMetric("innings", "batting"), summary.innings],
    ["Runs", getMetric("runs", "batting"), summary.runs],
    ["Avg", getMetric("average", "batting"), summary.average],
    [srLabel, getMetric(srKey, "batting"), summary[srKey]],
    ["HS", getMetric("high_score", "batting"), summary.high_score],
  ]);

  const splitHTML = `<div class="player-page__two-col">
    ${sectionHTML("By batting position", positionsTableHTML(extra.positions))}
    ${sectionHTML("Vs opposition", oppositionSectionHTML(state, "batting", extra.opposition))}
  </div>`;

  const howOut = sectionHTML("How out", howOutHTML(extra.dismissals));

  const progression = sectionHTML(
    "Scoring by balls faced",
    statCardsHTML([
      ["SR, balls 1–10", getMetric("sr_first10", "batting"), extra.progression.sr_first10],
      ["SR, balls 11–20", getMetric("sr_11_20", "batting"), extra.progression.sr_11_20],
      ["SR, balls 21+", getMetric("sr_21plus", "batting"), extra.progression.sr_21plus],
    ])
  );

  const matchups = battingMatchupsHTML(extra.matchups);

  return blockWrapperHTML("Batting", `${cardsHTML}${splitHTML}${howOut}${progression}${matchups}`);
}

function bowlingBlockHTML(state, summary, extra) {
  if (!summary || Number(summary.innings) === 0) {
    return blockWrapperHTML("Bowling", `<p class="player-page__note">No bowling in this scope.</p>`);
  }
  const cardsHTML = statCardsHTML([
    ["Inns", getMetric("innings", "bowling"), summary.innings],
    ["Wkts", getMetric("wickets", "bowling"), summary.wickets],
    ["Avg", getMetric("average", "bowling"), summary.average],
    ["Econ", getMetric("economy", "bowling"), summary.economy],
    ["SR", getMetric("strike_rate", "bowling"), summary.strike_rate],
    ["BBI", getMetric("best", "bowling"), summary.best],
  ]);

  const wicketTypes = sectionHTML("Wicket types", wicketTypesHTML(extra.wicketTypes));
  const opposition = sectionHTML("Vs opposition", oppositionSectionHTML(state, "bowling", extra.opposition));
  const matchups = bowlingMatchupsHTML(extra.matchups);

  return blockWrapperHTML("Bowling", `${cardsHTML}${wicketTypes}${opposition}${matchups}`);
}

/** Header: initials avatar + name + profile line, or the honest "no profile" note. */
function headerHTML(current, profile) {
  const heading = profile && profile.full_name ? profile.full_name : current.name;
  const showRegistryName = Boolean(profile && profile.full_name && profile.full_name !== current.name);
  let metaHTML = "";
  if (profile) {
    const role = profile.playing_role === "Unknown" ? null : profile.playing_role;
    const meta = [profile.country, role, profile.batting_style, profile.bowling_style].filter(Boolean).join(" · ");
    if (meta) metaHTML = `<p class="player-page__meta">${escHtml(meta)}</p>`;
  } else {
    metaHTML = `<p class="player-page__meta player-page__meta--note">No profile data for this player.</p>`;
  }
  return `
    <div class="player-page__header">
      <div class="player-page__avatar" aria-hidden="true">${escHtml(initials(heading))}</div>
      <div class="player-page__header-text">
        <h2 class="player-page__name">${escHtml(heading)}</h2>
        ${showRegistryName ? `<p class="player-page__registry-name">${escHtml(current.name)}</p>` : ""}
        ${metaHTML}
      </div>
    </div>`;
}

/** Non-scrolling header row (popup only): pairs with .player-popup__close —
 * see styles.css's .player-page__header-row comment for how the two line up
 * without being DOM siblings. Kept as one helper so all three shells (page,
 * loading, error) stay identical here. `showGraphButton` gates "Graph this
 * player" (task 4, decision 43): only the fully-loaded page shell passes
 * true — the loading/error shells have a `current` player but no confirmed
 * innings yet, so offering to chart them there would be premature. */
function headerRowHTML({ showGraphButton = false } = {}) {
  const graphBtnHTML = showGraphButton
    ? `<button type="button" class="btn btn--ghost player-page__graph-btn" data-role="graph-player">Graph this player</button>`
    : "";
  return `<div class="player-page__header-row">
      <button type="button" class="link-btn player-page__back" data-role="back">&larr; Find another player</button>
      ${graphBtnHTML}
    </div>`;
}

function pageHTML({ state, current, profile, battingSummary, battingExtra, bowlingSummary, bowlingExtra }) {
  const bothEmpty = Number(battingSummary.innings) === 0 && Number(bowlingSummary.innings) === 0;
  const body = bothEmpty
    ? `<p class="player-page__note">No innings for this player under the current scope — try widening the formats or dates above.</p>`
    : `${battingBlockHTML(state, battingSummary, battingExtra)}${bowlingBlockHTML(state, bowlingSummary, bowlingExtra)}`;

  return `
    <div class="player-page">
      ${headerRowHTML({ showGraphButton: true })}
      ${headerHTML(current, profile)}
      <p class="player-page__scope">${escHtml(scopeLine(state))}</p>
      ${body}
    </div>`;
}

function loadingShellHTML(current) {
  return `
    <div class="player-page">
      ${headerRowHTML()}
      <h2 class="player-page__name">${escHtml(current.name)}</h2>
      <p class="player-page__loading">Loading…</p>
    </div>`;
}

function errorShellHTML(current, err) {
  const message = (err && (err.userMessage || err.message)) || "Something went wrong loading this player.";
  return `
    <div class="player-page">
      ${headerRowHTML()}
      <h2 class="player-page__name">${escHtml(current.name)}</h2>
      <div class="error-box">
        <p>${escHtml(message)}</p>
        <button type="button" class="btn btn--primary" data-role="retry">Retry</button>
      </div>
    </div>`;
}

// ── Controller ────────────────────────────────────────────────────────────────

export function mountPlayerPage(container, store, { onGraphPlayer } = {}) {
  let current = null; // { id, name } | null
  let scopeKey = null; // the scope this page was last rendered/fetched for
  let loadToken = 0;
  let searchDebounceId = null;

  function bindShell(retryFn) {
    const backBtn = container.querySelector('[data-role="back"]');
    if (backBtn) {
      backBtn.addEventListener("click", () => {
        current = null;
        scopeKey = null;
        renderSearchMode();
      });
    }
    const retryBtn = container.querySelector('[data-role="retry"]');
    if (retryBtn) retryBtn.addEventListener("click", retryFn);

    // "Graph this player" (task 4, decision 43) — only present in the loaded
    // page shell (headerRowHTML's showGraphButton), so this is a no-op on
    // the loading/error shells.
    const graphBtn = container.querySelector('[data-role="graph-player"]');
    if (graphBtn) {
      graphBtn.addEventListener("click", () => {
        if (onGraphPlayer && current) onGraphPlayer(current.id, current.name);
      });
    }
  }

  // ---------- Search mode ----------

  function renderSearchMode() {
    container.innerHTML = `
      <div class="player-page-search">
        <h2 class="player-page-search__heading">Players</h2>
        <input type="text" class="input player-page-search__input" placeholder="Find a player…" aria-label="Find a player" />
        <div class="player-page-search__results" aria-live="polite"></div>
      </div>`;
    const input = container.querySelector(".player-page-search__input");
    const resultsEl = container.querySelector(".player-page-search__results");
    input.addEventListener("input", () => {
      clearTimeout(searchDebounceId);
      const term = input.value;
      searchDebounceId = setTimeout(() => runSearch(term, resultsEl), 200);
    });
  }

  async function runSearch(term, resultsEl) {
    const t = term.trim();
    if (t.length < 2) {
      resultsEl.innerHTML = "";
      return;
    }
    const token = ++loadToken;
    let rows;
    try {
      rows = await searchPlayers(t);
    } catch {
      if (token !== loadToken) return;
      resultsEl.innerHTML = `<p class="player-page-search__empty">Search failed — try again.</p>`;
      return;
    }
    if (token !== loadToken) return;
    if (rows.length === 0) {
      resultsEl.innerHTML = `<p class="player-page-search__empty">No players match.</p>`;
      return;
    }
    resultsEl.innerHTML = rows
      .map((r) => {
        const meta = [r.country, r.playing_role === "Unknown" ? null : r.playing_role].filter(Boolean).join(" · ");
        return `<button type="button" class="player-page-search__item" data-id="${escAttr(r.id)}" data-name="${escAttr(r.name)}">
          <span class="player-page-search__item-name">${escHtml(r.name)}</span>
          ${meta ? `<span class="player-page-search__item-meta">${escHtml(meta)}</span>` : ""}
        </button>`;
      })
      .join("");
    resultsEl.querySelectorAll(".player-page-search__item").forEach((btn) => {
      btn.addEventListener("click", () => showPlayer(btn.dataset.id, btn.dataset.name));
    });
  }

  // ---------- Player page ----------

  async function loadAndRenderPlayer() {
    const playerRef = current;
    const state = store.get();
    scopeKey = scopeKeyFor(state);
    const token = ++loadToken;

    container.innerHTML = loadingShellHTML(playerRef);
    bindShell(loadAndRenderPlayer);

    try {
      // battingCore/bowlingCore each merge what used to be 2-3 separate
      // same-FROM/WHERE queries into one row (Batch 5b C2, see playerData.js)
      // — the row carries every field the summary cards, dismissal
      // fingerprint, and progression cards (batting) / wicket-type bars
      // (bowling) need, so it's passed through unchanged as all three shapes.
      const [profile, battingCore, bowlingCore] = await Promise.all([
        fetchProfile(playerRef.id),
        fetchBattingCore(playerRef.id, state),
        fetchBowlingCore(playerRef.id, state),
      ]);
      if (token !== loadToken || current !== playerRef) return;
      const battingSummary = battingCore;
      const bowlingSummary = bowlingCore;

      let battingExtra = null;
      if (Number(battingSummary?.innings) > 0) {
        const [positions, opposition, matchups] = await Promise.all([
          fetchBattingPositions(playerRef.id, state),
          state.teamType === "international" ? fetchBattingOpposition(playerRef.id, state) : Promise.resolve(null),
          fetchBattingMatchups(playerRef.id, state),
        ]);
        if (token !== loadToken || current !== playerRef) return;
        battingExtra = { positions, dismissals: battingCore, progression: battingCore, opposition, matchups };
      }

      let bowlingExtra = null;
      if (Number(bowlingSummary?.innings) > 0) {
        const [opposition, matchups] = await Promise.all([
          state.teamType === "international" ? fetchBowlingOpposition(playerRef.id, state) : Promise.resolve(null),
          fetchBowlingMatchups(playerRef.id, state),
        ]);
        if (token !== loadToken || current !== playerRef) return;
        bowlingExtra = { wicketTypes: bowlingCore, opposition, matchups };
      }

      container.innerHTML = pageHTML({ state, current: playerRef, profile, battingSummary, battingExtra, bowlingSummary, bowlingExtra });
      bindShell(loadAndRenderPlayer);
    } catch (err) {
      if (token !== loadToken || current !== playerRef) return;
      container.innerHTML = errorShellHTML(playerRef, err);
      bindShell(loadAndRenderPlayer);
    }
  }

  // ---------- Public API ----------

  function showPlayer(id, name) {
    current = { id, name };
    loadAndRenderPlayer();
  }

  function onShow() {
    if (!current) {
      renderSearchMode();
      return;
    }
    if (scopeKeyFor(store.get()) !== scopeKey) {
      loadAndRenderPlayer();
    }
    // Same player, same scope: the DOM from the last render is still correct.
  }

  function onScopeChanged() {
    if (!current) return; // search mode: filters don't apply, nothing to do
    if (scopeKeyFor(store.get()) !== scopeKey) {
      loadAndRenderPlayer();
    }
  }

  return { onShow, onScopeChanged, showPlayer };
}

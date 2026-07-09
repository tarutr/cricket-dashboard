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
  fetchBattingSummary,
  fetchBattingPositions,
  fetchBattingOpposition,
  fetchBattingDismissals,
  fetchBattingProgression,
  fetchBowlingSummary,
  fetchBowlingWicketTypes,
  fetchBowlingOpposition,
} from "./playerData.js";
import { getMetric, DISMISSAL_KINDS } from "./metrics.js";
import { formatValue } from "./table.js";

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(s) {
  return escHtml(s).replace(/"/g, "&quot;");
}

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

  return blockWrapperHTML("Batting", `${cardsHTML}${splitHTML}${howOut}${progression}`);
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

  return blockWrapperHTML("Bowling", `${cardsHTML}${wicketTypes}${opposition}`);
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

function pageHTML({ state, current, profile, battingSummary, battingExtra, bowlingSummary, bowlingExtra }) {
  const bothEmpty = Number(battingSummary.innings) === 0 && Number(bowlingSummary.innings) === 0;
  const body = bothEmpty
    ? `<p class="player-page__note">No innings for this player under the current scope — try widening the formats or dates above.</p>`
    : `${battingBlockHTML(state, battingSummary, battingExtra)}${bowlingBlockHTML(state, bowlingSummary, bowlingExtra)}`;

  return `
    <div class="player-page">
      <button type="button" class="link-btn player-page__back" data-role="back">&larr; Find another player</button>
      ${headerHTML(current, profile)}
      <p class="player-page__scope">${escHtml(scopeLine(state))}</p>
      ${body}
    </div>`;
}

function loadingShellHTML(current) {
  return `
    <div class="player-page">
      <button type="button" class="link-btn player-page__back" data-role="back">&larr; Find another player</button>
      <h2 class="player-page__name">${escHtml(current.name)}</h2>
      <p class="player-page__loading">Loading…</p>
    </div>`;
}

function errorShellHTML(current, err) {
  const message = (err && (err.userMessage || err.message)) || "Something went wrong loading this player.";
  return `
    <div class="player-page">
      <button type="button" class="link-btn player-page__back" data-role="back">&larr; Find another player</button>
      <h2 class="player-page__name">${escHtml(current.name)}</h2>
      <div class="error-box">
        <p>${escHtml(message)}</p>
        <button type="button" class="btn btn--primary" data-role="retry">Retry</button>
      </div>
    </div>`;
}

// ── Controller ────────────────────────────────────────────────────────────────

export function mountPlayerPage(container, store) {
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
      const [profile, battingSummary, bowlingSummary] = await Promise.all([
        fetchProfile(playerRef.id),
        fetchBattingSummary(playerRef.id, state),
        fetchBowlingSummary(playerRef.id, state),
      ]);
      if (token !== loadToken || current !== playerRef) return;

      let battingExtra = null;
      if (Number(battingSummary?.innings) > 0) {
        const [positions, dismissals, progression, opposition] = await Promise.all([
          fetchBattingPositions(playerRef.id, state),
          fetchBattingDismissals(playerRef.id, state),
          fetchBattingProgression(playerRef.id, state),
          state.teamType === "international" ? fetchBattingOpposition(playerRef.id, state) : Promise.resolve(null),
        ]);
        if (token !== loadToken || current !== playerRef) return;
        battingExtra = { positions, dismissals, progression, opposition };
      }

      let bowlingExtra = null;
      if (Number(bowlingSummary?.innings) > 0) {
        const [wicketTypes, opposition] = await Promise.all([
          fetchBowlingWicketTypes(playerRef.id, state),
          state.teamType === "international" ? fetchBowlingOpposition(playerRef.id, state) : Promise.resolve(null),
        ]);
        if (token !== loadToken || current !== playerRef) return;
        bowlingExtra = { wicketTypes, opposition };
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

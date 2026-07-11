// src/graph/card.js
//
// The Paper Card (SPEC §6 / v1 §25.8 behavior) — the exportable artifact.
// Fixed light "paper" palette regardless of site theme (it's a printed
// artifact, not a themed UI surface): eyebrow line ("CRICDB · BATTING" style),
// title, subtitle, chart area, footer (left = honest scope line, right =
// watermark "cricdb").
//
// Title/subtitle are auto-generated and HONEST (§8.4): title from chart type
// + metric(s), subtitle from store.describeScope() (+ min-innings etc. — that
// text already comes from describeScope()). Both are contenteditable; a
// manual edit STICKS until the user next changes a chart PARAMETER (type,
// metric, players, filters) — then regeneration overwrites the text and
// clears the "edited" flag. The footer scope line is NEVER editable (honesty
// rule — it must always reflect the real applied filters).
//
// PNG export: lazy-loads vendored html2canvas ONLY when exporting, renders
// the card node at scale 2, downloads as cricdb-<slugified-title>.png.

let html2canvasPromise = null;

function loadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (!html2canvasPromise) {
    html2canvasPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "/vendor/html2canvas/html2canvas.min.js";
      script.onload = () => {
        if (window.html2canvas) {
          resolve(window.html2canvas);
        } else {
          // Don't memoize a broken load — reset so the next export click retries.
          html2canvasPromise = null;
          reject(new Error("html2canvas loaded but window.html2canvas is undefined"));
        }
      };
      script.onerror = () => {
        // Don't memoize a failed load — reset so the next export click retries.
        html2canvasPromise = null;
        reject(new Error("Failed to load /vendor/html2canvas/html2canvas.min.js"));
      };
      document.head.appendChild(script);
    });
  }
  return html2canvasPromise;
}

function slugify(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "chart"
  );
}

/**
 * Batch 3 part 2 (decision 43) — the title-honesty fix. Previously bar/donut/
 * radar titles said "top N" (or a bare "N players") purely from playerCount,
 * regardless of how the roster actually got to be N players — so a table
 * sorted by average, turned into a bar chart of Runs, still read "Runs — top
 * 15" even though the 15 shown are the top-15-BY-AVERAGE, not top-15-by-runs.
 * `roster` (passed in on config by graph.js, sourced from the selection
 * controller's dirty flag — players.js's createSelection — plus the metric
 * that ranked the last seed) makes the roster's provenance explicit instead
 * of inferred:
 *   - clean seed, ranked by the metric actually being charted -> "top N"
 *   - clean seed, ranked by a DIFFERENT metric -> "top N by <that metric>"
 *   - manually edited (or provenance unknown/unresolvable) -> "N players"
 * `displayedMetricKey` is the metric key this chart is ranking/showing (bar's
 * metric, donut's metric); radar has no single "displayed" metric (it shows a
 * GROUP), so it passes null and always takes the "by X" or "N players"
 * branch — there's no metric it could coincidentally match. Scatter makes no
 * count claim ("X vs Y") so it never calls this at all.
 */
function rankedCountPhrase(baseLabel, playerCount, roster, displayedMetricKey) {
  const dirty = roster ? Boolean(roster.dirty) : true; // unknown provenance = treat as dirty, never overclaim
  const seedByMetric = roster ? roster.seedByMetric : null;
  if (!dirty && seedByMetric) {
    if (displayedMetricKey && seedByMetric.key === displayedMetricKey) {
      return `${baseLabel} — top ${playerCount}`;
    }
    // Lowercase the whole label for mid-sentence use ("by batting average"),
    // preserving all-caps tokens (SR, BBI) and non-alphabetic chunks as-is.
    const lower = seedByMetric.label
      .split(" ")
      .map((w) => (/^[A-Z][a-z]/.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : w))
      .join(" ");
    return `${baseLabel} — top ${playerCount} by ${lower}`;
  }
  return `${baseLabel} — ${playerCount} player${playerCount === 1 ? "" : "s"}`;
}

/**
 * Build the auto title for the current chart configuration. Honest: only
 * describes what's actually charted (§8.4).
 */
export function autoTitle(config) {
  const { type } = config;
  if (type === "bar" || type === "donut") {
    return rankedCountPhrase(config.metric.label, config.playerCount, config.roster, config.metric.key);
  }
  if (type === "scatter") {
    return `${config.metricX.label} vs ${config.metricY.label}`;
  }
  if (type === "radar") {
    return rankedCountPhrase(config.group.label, config.playerCount, config.roster, null);
  }
  if (type === "phases") {
    // Same "group, not a single displayed metric" shape as radar — a family
    // is several metrics at once, so there's no single key that could
    // coincidentally match a seed's ranking metric (always "by X" or "N
    // players", never "top N" bare).
    return rankedCountPhrase(config.family.label, config.playerCount, config.roster, null);
  }
  if (type === "slope") {
    // Batch 4 part 1 (decision 43): "<Metric> — <window A> vs <window B>",
    // then the SAME top-N/by-X/N-players count phrasing every other ranked
    // chart type uses — windowALabel/windowBLabel are pre-formatted "Mon
    // YYYY–Mon YYYY" strings graph.js computes from its own date pickers (not
    // global filter state), so this module needs no month-name logic of its
    // own.
    const windowsPart =
      config.windowALabel && config.windowBLabel ? `${config.windowALabel} vs ${config.windowBLabel}` : "pick both windows";
    const base = `${config.metric.label} — ${windowsPart}`;
    return rankedCountPhrase(base, config.playerCount, config.roster, config.metric.key);
  }
  if (type === "byyear") {
    // Batch 4 wave 2, task 1 (renamed to "Line" per owner follow-up):
    // "<Metric> — Line — <count phrasing>". The year span itself lives in
    // the subtitle's scope sentence, not here — this module doesn't restate it.
    return rankedCountPhrase(`${config.metric.label} — Line`, config.playerCount, config.roster, config.metric.key);
  }
  if (type === "dumbbell") {
    // Batch 4 wave 2, task 2: "<Metric> — vs <Side A> vs <Side B>", then the
    // same count phrasing as bar/donut/slope.
    const base = `${config.metric.label} — vs ${config.labelA} vs ${config.labelB}`;
    return rankedCountPhrase(base, config.playerCount, config.roster, config.metric.key);
  }
  if (type === "benchmark") {
    // B8b (decision 44e): "<Anchor> vs the field" — no roster-count phrasing
    // at all (task brief: "the roster count phrasing does NOT apply"). Every
    // other branch above states how many players are drawn because each of
    // THEM draws one mark per player; Benchmark draws one row per METRIC
    // against a field the anchor is compared to, not a roster of marks, so
    // "top N"/"N players" would describe something this chart doesn't show.
    // No short-name concept exists for players anywhere in this codebase
    // (only metrics carry a `shortLabel` distinct from `label`) — the
    // anchor's plain `name` is used here exactly as it is in the bar
    // captions (benchmarkChart.js), flagged per the task brief's "full/short
    // name" wording having no real distinction to draw on.
    if (!config.anchorName) return "Choose an anchor player";
    return `${config.anchorName} vs the field`;
  }
  return "Untitled chart";
}

/** Identity of the "type/metric" parameters that gate the title-edit guard
 * below — deliberately narrower than "any chart parameter" (playerCount/
 * roster excluded): switching chart type or metric almost certainly makes a
 * user's custom title stale, so it's fine to overwrite; adding/removing a
 * player does not, so a manual edit should survive that. */
function regenKeyFor(config) {
  const { type } = config;
  if (type === "bar" || type === "donut") return JSON.stringify([type, config.metric.key]);
  if (type === "scatter") return JSON.stringify([type, config.metricX.key, config.metricY.key]);
  if (type === "radar") return JSON.stringify([type, config.group.id]);
  if (type === "phases") return JSON.stringify([type, config.family.id]);
  // Slope's title embeds the window ranges themselves, so a window-date
  // change must invalidate a manually-edited title exactly like a metric
  // change does — unlike bar/donut/radar, where only the roster size moves
  // and a custom title should survive that.
  if (type === "slope") return JSON.stringify([type, config.metric.key, config.windowALabel, config.windowBLabel]);
  if (type === "byyear") return JSON.stringify([type, config.metric.key]);
  // Dumbbell's title embeds both sides, mirroring slope's window-key
  // invalidation — changing either side's bucket must invalidate a
  // manually-edited title exactly like a metric change does.
  if (type === "dumbbell") return JSON.stringify([type, config.metric.key, config.sideAKey, config.sideBKey]);
  // B8b: the title text embeds ONLY the anchor's name (see autoTitle above) —
  // so, unlike every other type here, a metric-set change should NOT
  // invalidate a manually-edited title (the text doesn't reference metrics at
  // all); only switching the ANCHOR does, since that's the one thing the
  // title actually says.
  if (type === "benchmark") return JSON.stringify([type, config.anchorId]);
  return JSON.stringify([type]);
}

/** Build the auto subtitle: the scope sentence, honest and never editable-derived. */
export function autoSubtitle(scopeDescription) {
  return scopeDescription;
}

/** Eyebrow line, e.g. "CRICDB · BATTING". */
export function eyebrowFor(discipline) {
  return `CRICDB · ${discipline.toUpperCase()}`;
}

/**
 * Mount the paper card into `container`. Returns a controller with
 * `regenerate(config, scopeDescription)` — call whenever a chart PARAMETER
 * changes (type/metric/players/filters); this overwrites title/subtitle and
 * clears the edited flags UNLESS the user has manually edited them, in which
 * case regeneration still overwrites (per spec: "regeneration overwrites and
 * clears the edited flag" — the edit only "sticks" between regenerations, not
 * across them).
 */
export function mountCard(container) {
  container.innerHTML = `
    <div class="paper-card" data-role="paper-card">
      <div class="paper-card__eyebrow" data-role="eyebrow"></div>
      <h2 class="paper-card__title" data-role="title" contenteditable="true" spellcheck="false" title="Click to edit"></h2>
      <p class="paper-card__subtitle" data-role="subtitle" contenteditable="true" spellcheck="false" title="Click to edit"></p>
      <div class="paper-card__chart-area" data-role="chart-area">
        <div class="paper-card__chart-viewport" data-role="chart-viewport">
          <canvas data-role="canvas"></canvas>
          <p class="paper-card__placeholder" data-role="placeholder" hidden></p>
        </div>
      </div>
      <div class="paper-card__footer" data-role="footer">
        <span class="paper-card__scope" data-role="footer-scope"></span>
        <span class="paper-card__watermark">cricdb</span>
      </div>
    </div>
  `;

  const els = {
    card: container.querySelector('[data-role="paper-card"]'),
    eyebrow: container.querySelector('[data-role="eyebrow"]'),
    title: container.querySelector('[data-role="title"]'),
    subtitle: container.querySelector('[data-role="subtitle"]'),
    chartArea: container.querySelector('[data-role="chart-area"]'),
    // Chart.js (and the radar/benchmark DOM builders, via canvas.parentElement
    // — see charts.js/benchmarkChart.js) size themselves to THIS element, not
    // chart-area — see styles.css's .paper-card__chart-viewport for why.
    chartViewport: container.querySelector('[data-role="chart-viewport"]'),
    canvas: container.querySelector('[data-role="canvas"]'),
    placeholder: container.querySelector('[data-role="placeholder"]'),
    footer: container.querySelector('[data-role="footer"]'),
    footerScope: container.querySelector('[data-role="footer-scope"]'),
  };

  let titleEdited = false;
  let subtitleEdited = false;
  let currentTitle = "";
  // The [type, metric-key(s)] identity as of the last regenerate() call — see
  // regenKeyFor()'s doc comment. null until the first regenerate().
  let lastTitleRegenKey = null;

  els.title.addEventListener("input", () => {
    titleEdited = true;
  });
  els.subtitle.addEventListener("input", () => {
    subtitleEdited = true;
  });
  // Prevent literal newlines inside contenteditable single-line fields.
  for (const el of [els.title, els.subtitle]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") e.preventDefault();
    });
  }

  /**
   * Regenerate title/subtitle/eyebrow/footer from the current chart config.
   * Callers should only invoke this when a parameter actually changed, not on
   * every render, so in-place edits persist across re-renders that don't
   * change params (graph.js gates this on its `pendingRegenerate` flag, set
   * whenever chart type/metric/players/filters move).
   *
   * TITLE guard (Batch 3 part 2, decision 43 — narrower than the subtitle's):
   * once the user types into the title, auto-regeneration stops for THAT
   * FIELD ONLY until the chart type or displayed metric(s) actually change
   * (regenKeyFor() identity) — a player add/remove/roster reseed alone does
   * NOT clear a manual title edit, since those don't make an explicit custom
   * title wrong the way switching what's charted does. The subtitle has no
   * such guard: it's the scope sentence, and always regenerates+resets on
   * every regenerate() call (unchanged from before this batch).
   */
  function regenerate(config, scopeDescription) {
    els.eyebrow.textContent = eyebrowFor(config.discipline);
    const newKey = regenKeyFor(config);
    const newTitle = autoTitle(config);
    if (!titleEdited || newKey !== lastTitleRegenKey) {
      currentTitle = newTitle;
      els.title.textContent = currentTitle;
      titleEdited = false;
    }
    lastTitleRegenKey = newKey;
    els.subtitle.textContent = autoSubtitle(scopeDescription);
    els.footerScope.textContent = scopeDescription;
    subtitleEdited = false;
  }

  /** Update ONLY the footer scope line (always honest, never editable) without touching title/subtitle edit state. */
  function updateFooterScope(scopeDescription) {
    els.footerScope.textContent = scopeDescription;
  }

  function getCanvas() {
    return els.canvas;
  }

  /**
   * Batch 3 (graphs, part 1) min-cap handling (decision 43): when a chart
   * type's player selection is below its minimum, the paper card shows a
   * short honest note in place of a chart rather than attempting to draw one
   * (e.g. a 1-bar "ranking"). The canvas is hidden (not removed) so a
   * subsequent real chart just un-hides it.
   */
  function showPlaceholder(message) {
    els.canvas.hidden = true;
    els.placeholder.textContent = message;
    els.placeholder.hidden = false;
  }
  function hidePlaceholder() {
    els.canvas.hidden = false;
    els.placeholder.hidden = true;
    els.placeholder.textContent = "";
  }

  function isEdited() {
    return titleEdited || subtitleEdited;
  }

  /**
   * Owner decision 46 ("what you see is what exports"): below the 900px
   * breakpoint, .paper-card__chart-area is a horizontally-scrollable
   * VIEWPORT onto the fixed-width .paper-card__chart-viewport (styles.css) —
   * so at export time the user may currently be panned to any position
   * inside it. Export/copy must always capture the FULL canonical-width
   * chart regardless of that pan position, not whatever slice happens to be
   * scrolled into view.
   *
   * html2canvas crops to the TARGET element's own box even when a
   * descendant visually overflows it with `overflow: visible` (verified
   * empirically against the vendored build before writing this — widening
   * only the inner scroller had no effect; the target itself has to widen
   * too). So this widens the clone's chart-area (matching the live
   * chart-viewport's rendered width, with overflow neutralized) AND the
   * card around it, wide enough that nothing needs to be cropped. Widening
   * the card alone would also make the title/subtitle/footer re-wrap at
   * that wider width, which is exactly the "export looks different from the
   * screen" bug this batch exists to remove (SPEC §8.4-style honesty, plus
   * the task's explicit "screen==export for whatever it includes" rule) —
   * so those three are pinned to their OWN already-rendered widths first,
   * confirmed by the same empirical check to keep the card's height/wrap
   * identical to what's on screen.
   *
   * A no-op above the 900px breakpoint: desktop has no scrollable
   * chart-area to begin with (this function's early return), so its export
   * is byte-for-byte the same call this codebase already made.
   */
  function widenCloneForCanonicalExport(clonedDoc) {
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    const clonedCard = clonedDoc.querySelector('[data-role="paper-card"]');
    const clonedChartArea = clonedDoc.querySelector('[data-role="chart-area"]');
    if (!clonedCard || !clonedChartArea) return;

    const canonicalWidth = els.chartViewport.getBoundingClientRect().width;
    if (!canonicalWidth) return;

    const outerWidth = (el, innerWidth) => {
      const s = window.getComputedStyle(el);
      const extra =
        parseFloat(s.paddingLeft || 0) +
        parseFloat(s.paddingRight || 0) +
        parseFloat(s.borderLeftWidth || 0) +
        parseFloat(s.borderRightWidth || 0);
      return innerWidth + extra;
    };

    clonedChartArea.style.overflow = "visible";
    clonedChartArea.style.width = `${canonicalWidth}px`;
    clonedChartArea.scrollLeft = 0;

    // chart-area's own OUTER width (content + its padding/border), then the
    // card's OUTER width around THAT — the card must be at least wide enough
    // to contain the widened chart-area without cropping it.
    const chartAreaOuterWidth = outerWidth(els.chartArea, canonicalWidth);
    clonedCard.style.width = `${outerWidth(els.card, chartAreaOuterWidth)}px`;
    clonedCard.style.maxWidth = "none";

    // Pin title/subtitle/footer to their current on-screen widths so a
    // wider card (for the chart's sake) never changes how they wrap —
    // "screen==export for whatever it includes" (task brief).
    for (const role of ["title", "subtitle", "footer"]) {
      const live = els[role];
      const cloned = clonedDoc.querySelector(`[data-role="${role}"]`);
      if (!live || !cloned) continue;
      const w = live.getBoundingClientRect().width;
      cloned.style.width = `${w}px`;
      cloned.style.maxWidth = `${w}px`;
      cloned.style.flexShrink = "0";
      cloned.style.boxSizing = "border-box";
    }
  }

  function html2canvasOptions() {
    return {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: true,
      onclone: widenCloneForCanonicalExport,
    };
  }

  async function exportPNG(exportButton) {
    const originalText = exportButton ? exportButton.textContent : null;
    if (exportButton) {
      exportButton.disabled = true;
      exportButton.textContent = "Exporting…";
    }
    try {
      const html2canvas = await loadHtml2Canvas();
      // Blur any focused contenteditable so no caret/selection artifact is captured.
      if (document.activeElement && els.card.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      const canvas = await html2canvas(els.card, html2canvasOptions());
      const dataUrl = canvas.toDataURL("image/png");
      const titleForSlug = els.title.textContent || currentTitle || "chart";
      const filename = `cricdb-${slugify(titleForSlug)}.png`;

      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      return { ok: true, dataUrl, filename };
    } catch (e) {
      return { ok: false, error: e };
    } finally {
      if (exportButton) {
        exportButton.disabled = false;
        exportButton.textContent = originalText;
      }
    }
  }

  /** Feature-detect the Clipboard image API — the "Copy PNG" button is
   * hidden entirely (not shown disabled) on browsers without it. */
  function canCopyPNG() {
    return !!(navigator.clipboard && typeof navigator.clipboard.write === "function" && typeof window.ClipboardItem === "function");
  }

  /** Same render as exportPNG (html2canvas @ scale 2), copied to the system
   * clipboard via canvas.toBlob + ClipboardItem instead of downloaded. */
  async function copyPNG(copyButton) {
    const originalText = copyButton ? copyButton.textContent : null;
    if (copyButton) {
      copyButton.disabled = true;
      copyButton.textContent = "Copying…";
    }
    try {
      const html2canvas = await loadHtml2Canvas();
      if (document.activeElement && els.card.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      const canvas = await html2canvas(els.card, html2canvasOptions());
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas produced no image data"))), "image/png");
      });
      await navigator.clipboard.write([new window.ClipboardItem({ "image/png": blob })]);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    } finally {
      if (copyButton) {
        copyButton.disabled = false;
        copyButton.textContent = originalText;
      }
    }
  }

  return {
    regenerate,
    updateFooterScope,
    getCanvas,
    showPlaceholder,
    hidePlaceholder,
    isEdited,
    exportPNG,
    canCopyPNG,
    copyPNG,
    els,
  };
}

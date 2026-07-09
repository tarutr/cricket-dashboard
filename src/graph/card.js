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
 * Build the auto title for the current chart configuration. Honest: only
 * describes what's actually charted (§8.4).
 */
export function autoTitle(config) {
  const { type } = config;
  if (type === "bar") {
    return `${config.metric.label} — top ${config.playerCount}`;
  }
  if (type === "donut") {
    return `${config.metric.label} — share of total`;
  }
  if (type === "scatter") {
    return `${config.metricX.label} vs ${config.metricY.label}`;
  }
  if (type === "radar") {
    return `${config.group.label} — ${config.playerCount} player${config.playerCount === 1 ? "" : "s"}`;
  }
  return "Untitled chart";
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
      <h2 class="paper-card__title" data-role="title" contenteditable="true" spellcheck="false"></h2>
      <p class="paper-card__subtitle" data-role="subtitle" contenteditable="true" spellcheck="false"></p>
      <div class="paper-card__chart-area" data-role="chart-area">
        <canvas data-role="canvas"></canvas>
      </div>
      <div class="paper-card__footer">
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
    canvas: container.querySelector('[data-role="canvas"]'),
    footerScope: container.querySelector('[data-role="footer-scope"]'),
  };

  let titleEdited = false;
  let subtitleEdited = false;
  let currentTitle = "";

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
   * Per v1 §25.8: a manual edit STICKS until the next regeneration call (i.e.
   * until the caller next changes a chart parameter) — at THAT point this
   * function overwrites the text and resets the edited flags. Callers should
   * only invoke this when a parameter actually changed, not on every render,
   * so in-place edits persist across re-renders that don't change params.
   */
  function regenerate(config, scopeDescription) {
    els.eyebrow.textContent = eyebrowFor(config.discipline);
    currentTitle = autoTitle(config);
    els.title.textContent = currentTitle;
    els.subtitle.textContent = autoSubtitle(scopeDescription);
    els.footerScope.textContent = scopeDescription;
    titleEdited = false;
    subtitleEdited = false;
  }

  /** Update ONLY the footer scope line (always honest, never editable) without touching title/subtitle edit state. */
  function updateFooterScope(scopeDescription) {
    els.footerScope.textContent = scopeDescription;
  }

  function getCanvas() {
    return els.canvas;
  }

  function isEdited() {
    return titleEdited || subtitleEdited;
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
      const canvas = await html2canvas(els.card, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
      });
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

  return {
    regenerate,
    updateFooterScope,
    getCanvas,
    isEdited,
    exportPNG,
    els,
  };
}

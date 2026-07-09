// src/html.js
//
// ONE shared HTML-escaping module (Batch 2 review fix). Every module used to
// define its own local esc/escAttr/escHtml helper — several of them subtly
// wrong (escHtml variants that didn't escape `"`, used inside double-quoted
// attributes). This is the single predicate every innerHTML interpolation of
// a data-derived string (player/team names, dismissal kinds, filter labels,
// error messages) must go through, matching the "ONE shared predicate" spirit
// of SPEC §8.1's hasMetricData rule.
//
// escHtml is for TEXT NODE content; escAttr is for double-quoted HTML
// ATTRIBUTE VALUES. escHtml already escapes both `"` and `'`, so the two are
// equivalent today — escAttr exists as its own name so call sites document
// where the string lands, and so the two can diverge later without a
// call-site rewrite.

export function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const escAttr = escHtml;

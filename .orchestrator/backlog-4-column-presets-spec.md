# Backlog #4 — Column-group preset AUDIT + restructure proposal (2026-07-23)

Full audit, owner-requested. Not a build — a spec to react to. Presets live in `src/state.js`
`COLUMN_PRESET_DEFS` (a per-discipline list; each preset is `columns(formats) => keys | null`, null hides
the chip). Palette = `metricsFor("batting")` (48) / `metricsFor("bowling")` (31). Format buckets:
**Red Ball** (Test+MDM), **50 Over** (ODI+ODM), **T20** (T20+IT20).

## CURRENT STATE
Only **Core** and **Phases** are format-aware; the rest are static (same columns in every format).

BATTING presets: Core · Boundaries · Dismissals · Phases · Progression
- Core: Matches·Innings·Runs·Average·SR·HS·Fours·Sixes  (Red Ball swaps SR→Balls per Dismissal, owner ruling)
- Boundaries: Innings·Runs·Fours·Sixes·Boundary%·Balls per Boundary·Dot%
- Dismissals: Innings·Runs·Average·Caught%·Bowled%·LBW%·RunOut%·Stumped%·C&B%·HitWkt%
- Phases: T20→Inns·Runs·SR·PP SR·Mid SR·Death SR ; 50 Over→ODI equivalents ; Red Ball→null (chip hidden)
- Progression: Innings·Runs·SR·SR(1–10)·SR(11–20)·SR(21+)   [static — offered in every format]

BOWLING presets: Core · Control · Wicket types · Phases
- Core: Matches·Innings·Wickets·Average·Economy·SR·Best
- Control: Innings·Wickets·Economy·Dot%·Boundary% Conceded·Maidens
- Wicket types: Innings·Wickets·Bowled·LBW·Caught·C&B·Stumped·HitWkt
- Phases: T20→Inns·Wkts·PP Econ·Death Econ·PP Wkts·Death Wkts (NO middle!) ; 50 Over→ODI ; Red Ball→null

### Problems
1. Not format-tailored: Progression (a short-innings idea) is offered for Red Ball & 50-over where it's
   near-meaningless; Boundaries/Control/Wicket-types identical across formats.
2. Core is weak vs Statsguru: batting Core has NO **100s/50s/ducks/Not-outs**; bowling Core has NO
   **maidens/overs/4w/5w** and isn't format-differentiated.
3. Bowling Phases omits the **Middle** bucket even though decision 58 added mid_economy/mid_wickets.
4. No red-ball-specific view — the owner wants "phases (white) vs innings (red)".

## STATSGURU REFERENCE (default career columns)
- Batting (all formats, largely uniform): Mat · Inns · NO · Runs · HS · Ave · BF · SR · 100 · 50 · 0 · 4s · 6s.
  Emphasis shifts: Tests→Ave + 100s ; T20→SR + boundaries ; ODI→both.
- Bowling: Mat · Inns · Overs · Mdns · Runs · Wkts · BBI · **BBM(Tests)** · Ave · Econ · SR · 4w · 5w · **10w(Tests)**.
  Emphasis: Tests→Ave + SR + 5w/10w ; T20→Econ + dot% + 4w ; ODI→both.

### Palette GAPS vs Statsguru — and feasibility
| Missing metric | Discipline | How to add | Pipeline? |
|---|---|---|---|
| 50s (runs 50–99), 100s (≥100), ducks (0 & out), Not-outs | batting | `SUM(CASE WHEN runs>=100…)` over batting_innings rows | **NO — metrics.js only** |
| 4-wkt hauls (inns wkts≥4), 5-wkt hauls (≥5) | bowling | `SUM(CASE WHEN wickets>=5…)` over bowling_innings rows | **NO — metrics.js only** |
| Overs (display of balls/6) | bowling | format the existing `balls` | NO — display only |
| By-phase Dot%/Boundary%/Average as TABLE columns | both | metric defs over the #3 columns (already in parquet) | **NO — metrics.js only** |
| 10-wkt match hauls, BBM (best match) | bowling (red) | needs MATCH-level rollup (our grain is per-innings) | HARD — different query shape; likely SKIP |

Big finding: **almost every Statsguru staple we lack is a metrics.js `sqlExpression` over columns we already
have — NO pipeline run needed.** Only match-level (10w/BBM) is hard.

## PROPOSED RESTRUCTURE
Mechanism: keep the existing `columns(formats)=>keys|null` pattern (null hides the chip). Enrich every
preset to be format-aware, and let the MENU differ per format bucket by returning null where a preset
doesn't apply. Result — the dropdown shows only presets that make cricket sense for the current
discipline+format.

### BATTING
| Preset | Red Ball | 50 Over | T20 | Use case |
|---|---|---|---|---|
| **Core** | Mat·Inns·NO·Runs·HS·**Ave**·100·50·BpD | Mat·Inns·NO·Runs·HS·Ave·SR·100·50 | Mat·Inns·Runs·HS·Ave·**SR**·50·4s·6s | the everyday line, format-weighted |
| **Boundaries** | (hide or keep light) | Inns·Runs·4s·6s·Bdry%·BpB·Dot% | same | scoring shape / aggression |
| **Phases** | — (hidden) | ODI PP/Mid/Death SR | T20 PP/Mid/Death SR | where runs come in the innings (WHITE) |
| **Progression** | — (hidden) | (optional; coarse) | Inns·Runs·SR·SR 1–10·11–20·21+ | innings build-up (T20-shaped) |
| **Conversion** (NEW, red analog) | Inns·NO·Runs·HS·Ave·100·50·**0s**·BpD | (optional) | — | longevity/conversion (RED) |
| **Dismissals** | keep | keep | keep | how they get out (all formats) |

### BOWLING
| Preset | Red Ball | 50 Over | T20 | Use case |
|---|---|---|---|---|
| **Core** | Mat·Inns·Overs·Mdns·Runs·Wkts·BBI·**Ave·SR**·5w | Mat·Inns·Overs·Mdns·Runs·Wkts·BBI·Ave·Econ·SR·4w·5w | Mat·Inns·Overs·Runs·Wkts·**Econ**·Ave·SR·4w·Dot% | everyday line, format-weighted |
| **Control** | (keep, light) | Inns·Wkts·Econ·Dot%·Bdry%Conc·Mdns | same | containment (WHITE esp.) |
| **Wicket types** | keep | keep | keep | how wickets fall (all formats) |
| **Phases** | — (hidden) | ODI PP/**Mid**/Death Econ+Wkts | T20 PP/**Mid**/Death Econ+Wkts | phase workload (WHITE) — ADD middle |
| **Hauls** (NEW, red analog) | Inns·Wkts·BBI·5w·(10w?)·Ave·SR | (optional 4w/5w) | — | match-winning spells (RED) |

### T20 vs 50-over (owner "possibly")
Differences are mostly Core EMPHASIS (T20→Econ/SR/boundaries; ODI→Ave+Econ+100s) and:
- Phases: already different ranges (T20 0–5/6–14/15–19 vs ODI 0–9/10–39/40–49) — handled by columns.
- Progression: the 1–10/11–20/21+ buckets suit a ~20–30-ball T20 innings; for 50-over a batter faces 50–120
  balls so "21+" is a giant catch-all → Progression is really a T20 view. Offer it only for T20 (hide/coarse
  for ODI), OR leave as-is and note the limitation. (We only store those 3 progression buckets.)

## OPEN DECISIONS FOR OWNER (cricket judgement)
1. **Add the counting metrics?** 50s/100s/ducks/NO (batting) + 4w/5w (bowling) — metrics.js only, no pipeline.
   Needed for a Statsguru-faithful Core. Yes/no + exact set.
2. **Core contents per bucket** — confirm/adjust the six tables above (esp. keep BF? keep SR in red-ball core
   or only BpD? include boundaries in T20 Core?).
3. **Red-ball analogs** — do you want a **Conversion** (batting) and **Hauls** (bowling) preset in place of
   Phases/Progression for Red Ball? Confirm their columns.
4. **Bowling Phases: add the Middle bucket** (decision 58 metrics now exist)? And show econ+wkts for all
   three phases?
5. **Enrich white-ball Phases with the #3 by-phase Dot%/Boundary%/Average as columns** (metrics.js only)?
6. **T20 vs 50-over**: split the menus, or just weight Core differently and share the rest?
7. **10w/BBM (red-ball match-level)** — skip (grain mismatch), or is it worth a separate match-level query later?

## Build shape (once decided)
- New metric defs in `metrics.js` (counting metrics; optional phase table columns) — numbers-critical →
  data-engineer (Opus/xhigh), test-first, anchors held. NO pipeline (all over existing columns).
- Preset restructure in `state.js` `COLUMN_PRESET_DEFS` (format-aware + null-hides) — frontend-engineer (Sonnet).
- Verify: presets render per format/discipline; each column resolves; anchors intact; independent DuckDB
  check for each new counting metric (e.g., a known player's 100s/5w counts).

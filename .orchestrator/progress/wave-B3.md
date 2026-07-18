# Wave B3 — make the 4 vsTableOnly Vs stats GRAPHABLE

Owner ruling 2026-07-18: the four Wave-4c Vs stats (Matches, High Score, Runs per
Innings, Best Bowling) must be graphable in the Graph Builder (handoff deferred it
here). B1/B2 had deliberately excluded them via `vsTableOnly:true`.

## DONE
- **graph.js `graphMetrics()`** (~283): dropped the `!m.vsTableOnly` clause; kept
  `m.kind !== "composition"`. The four now enter the metric pool; existing
  per-chart filters decide applicability. (Comment block above the fn updated so
  it no longer claims the exclusion — it's part of the fn's own doc.)
- **timeseries.js `timeseriesSupported()`**: removed the `if (metricDef.vsTableOnly)
  return false` guard in the matchup branch; kind check alone now decides. Doc
  comment updated. Matches(total)+RPI(rate) become Line-able; HS/Best stay out via
  kind:"peak". Plain path byte-identical (only the matchup-source branch changed).
- **charts.js**: added shared `chartValue(metric,row)` = `Number(row[key])` when
  finite ELSE `Number(row[key+"__sort"])`. Used in bar (`buildBarChart`), scatter
  (`buildScatterChart`), radar (`buildRadarSmallMultiples`) for the plotted value;
  DISPLAY labels still use `row[key]` via `labelForValue` (bar stores `raw`,
  scatter stores `rawX/rawY`, radar reads `row[key]` in the tooltip). So Best
  Bowling plots by RANK height but is LABELLED "W-R".
- `hasMetricData` needed NO change — its `format==="str"` branch already treats
  "2-9" as data (confirmed: Best Bowling renders with 0 excluded).
- **Benchmark NOT touched**: `benchmarkEligibleMetrics` has its OWN independent
  `!m.vsTableOnly` + `format!=="str"` + kind + `higherIsBetter!==null` filters, so
  none of the four ever reach `computeBenchmarkRows` — the accessor is not needed
  there. See CONCERNS.

## INDEPENDENT NUMBERS (hand-written DuckDB, not the app's shape)
- High Score vs Spin, SA Yadav (271f83cd) = **47** (MAX per-innings SUM(runs)).
- Matches vs Spin = **38**; Runs = **454**; Innings = **38**; RPI = 454/38 =
  **11.947** (dec1 label = "11.9").
- Best Bowling vs Right-hand bat, JJ Bumrah (462411b3) = **"2-9"**, rank
  `2*1000-9` = **1991**.
- App `fetchSelectedPlayerMetrics` returns these EXACT values; matchup branch
  carries `best__sort=1991`. Anchor: SA Yadav vs Spin still 38/454/140.99.

## BYTE-IDENTICAL REGRESSION (via real buildBarChart + Chart global)
- Plain Runs bar: Karanbir Singh height **2,454** (leaderboard anchor).
- Vs=Spin Runs bar: Waseem Muhammad **701** (B1 anchor); Virandeep 688.
- Best Bowling bar (5 players): heights = ranks, correct W-R tie-break
  (5-7=4993 > 5-10=4990 > 4-19 > 3-5 > 3-19), labels = the "W-R" strings, 0 excluded.
- Radar with `best` axis: 4 minis, 0 excluded, pool carries best__sort. No crash.

## PICKER ELIGIBILITY (exact predicates; also seen on-screen)
matchup_batting: Matches → Bar/Scatter+Line; High Score → Bar/Scatter+Radar;
RPI → Bar/Scatter+Radar+Slope/Dumbbell+Line. matchup_bowling: Best → Bar/Scatter+
Radar; Matches → Bar/Scatter+Line. NOT Matches for Radar/Benchmark (satisfied).
On-screen: Bar metric dropdown under Vs=Spin lists Matches, High Score, Runs per
Innings. Zero console errors on boot.

## GOTCHAS / CONCERNS (see report)
- Benchmark asymmetry: RPI would fit Benchmark numerically but is kept out by
  benchmarkEligibleMetrics' own `!m.vsTableOnly`, which the brief's 3 changes don't
  touch. Left as-is (brief scoped benchmark edits to "only if value-extraction
  needs the accessor" — it doesn't). Flagged for owner/orchestrator.
- deriveChecked (graph.js Best/Worst roster ranking, lines ~972-976) ranks by
  `Number(row[key])` = NaN for `best` — PRE-EXISTING (plain best was already
  offered), now also reachable for Vs best. Brief says "don't change anything else
  in graph.js", so left untouched + flagged.
- ALSO FIXED: plain Best Bowling (bowling namespace) was offered in the graph but
  rendered NaN (Number("2-9")) — chartValue fixes it too (plots by rank, "W-R"
  label). Behaviour change, intended per brief.

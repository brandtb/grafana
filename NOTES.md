# Series Isolation Bug — Investigation Notes

## The Bug (Grafana issue #124866)

**Symptom:** In a Time Series panel with a mix of numeric and boolean/enum series, clicking a legend
item to isolate a numeric series causes boolean/enum series to unexpectedly reappear (or disappear).

**Root cause:** `getDisplayNames()` and `getNamesOfHiddenFields()` in `seriesVisibilityConfigFactory`
only counted `FieldType.number` fields as "plottable." When a user isolated all numeric series,
`allFieldsAreExcluded()` compared the length of the isolated set against only the numeric field count.
With 2 numeric fields isolated, `2 === 2` returned true → the override was removed → boolean/enum
fields reappeared.

---

## Fix Locations

### 1. `grafana/scenes` — affects all dashboard panels (primary fix)

**File:** `packages/scenes/src/components/VizPanel/seriesVisibilityConfigFactory.ts`

`VizPanel` in scenes is the panel container used by all Grafana dashboards. It has its own copy of
`seriesVisibilityConfigFactory` that is completely independent of the Grafana repo. This is the fix
that matters for dashboards.

**Change:** Added local helper `isTimeseriesValueFieldType` and replaced both
`field.type !== FieldType.number` checks in `getDisplayNames` and `getNamesOfHiddenFields`:

```ts
const isTimeseriesValueFieldType = (type: FieldType): boolean =>
  type === FieldType.number || type === FieldType.boolean || type === FieldType.enum;
```

**Note:** The function is named `isTimeseriesValueFieldType` (not `isPlottableFieldType`) to match
the canonical name used in `@grafana/data`, so when scenes eventually bumps its `@grafana/data`
dependency to include the exported version, the swap is a one-line import replacement.

**Status:** Fixed locally in `/workspaces/scenes`. Needs PR to `github.com/grafana/scenes`.

---

### 2. Grafana repo — affects Explore only

**File:** `public/app/features/dashboard/dashgrid/SeriesVisibilityConfigFactory.ts`

This file is only called from `ExploreGraph.tsx`. Dashboard panels use the scenes version exclusively
(`DashboardPageProxy` unconditionally renders `DashboardScenePage`; the old `DashboardGrid` rendering
chain is unreachable dead code). The same `number`-only bug existed here.

**Change:** Replaced `field.type !== FieldType.number` checks with the inline three-way check
(not imported from `@grafana/data`, since this file is deprecated/near-dead code):

```ts
field.type !== FieldType.number && field.type !== FieldType.boolean && field.type !== FieldType.enum
```

**Status:** Fixed on branch `fix/time-series-isolation-boolean`.

---

### 3. Grafana repo — Explore graph not rendering at all for boolean/enum data

**File:** `public/app/features/explore/utils/decorators.ts`

**Symptom:** When querying a datasource that returns boolean or enum time series in Explore, the
Graph section doesn't appear at all — Explore silently falls back to showing only the Table.

**Root cause:** `isTimeSeries()` only recognized a frame as graphable if it contained exactly two
field types: `FieldType.time` and `FieldType.number`. Frames with boolean or enum value fields
(either alone or mixed with number fields) were never added to `graphFrames`.

**Change:** Rewrote `isTimeSeries()` to accept any combination of plottable value types alongside
a single time field, while still rejecting frames with string/other non-plottable types (log frames,
table data, etc.):

```ts
function isTimeSeries(frame: DataFrame): boolean {
  const grouped = groupBy(frame.fields, (field) => field.type);
  if (grouped[FieldType.time]?.length !== 1) {
    return false;
  }
  const valueTypes = Object.keys(grouped).filter((t) => t !== FieldType.time);
  return valueTypes.length > 0 && valueTypes.every((t) => isTimeseriesValueFieldType(t as FieldType));
}
```

**Status:** Fixed on branch `fix/time-series-isolation-boolean`.

---

### 4. Shared predicate added to `@grafana/data`

**File:** `packages/grafana-data/src/dataframe/utils.ts`

Added and exported `isTimeseriesValueFieldType` as the single canonical definition of "plottable
field type" for time series visualizations. Used to replace duplicate inline checks in:

- `packages/grafana-data/src/dataframe/utils.ts` (`alignTimeRangeCompareData`)
- `public/app/plugins/panel/timeseries/utils.ts` (`setClassicPaletteIdxs`)
- `packages/grafana-ui/src/components/VizTooltip/utils.ts` (`getContentItems`)
- `public/app/features/explore/utils/decorators.ts` (`isTimeSeries`)

**Status:** Implemented on branch `fix/time-series-isolation-boolean`.

---

## Existing PR #125048

PR #125048 was submitted against `grafana/grafana` for this issue. It only fixes the Grafana repo's
`SeriesVisibilityConfigFactory.ts`, which covers Explore but has no effect on dashboard panels
(which use the scenes version). It is unlikely to have been tested against a dashboard with boolean
series.

---

## Architectural Issue — Field Types Should Not Be Hardcoded in Scenes

`seriesVisibilityConfigFactory` in scenes hard-codes which field types count as "plottable series."
This is the wrong owner for that knowledge — it belongs to the panel plugin, not the framework.

**Why it works in practice today:**
- Panels that don't support boolean/enum (e.g., histogram) filter those field types out during
  their own data preparation step, so `seriesVisibilityConfigFactory` never sees them in the data
  argument. The type filter in the factory is therefore redundant (but harmless) for those panels.
- Panels that do support boolean/enum (time series) pass them through, which is why the bug
  manifested there.

**Risk:** A future panel that keeps mixed field types in its processed data but only considers some
of them "series" would get incorrect behavior from the factory's hardcoded list.

**State timeline:** Uses `GraphNG` → `PlotLegend` → `onToggleSeriesVisibility`, so it can
trigger `seriesVisibilityConfigFactory`. State timeline uses `FieldType.string` for discrete state
values. String fields are not counted by the current fix, which could cause incorrect behavior for
state timeline series isolation. Not confirmed as a bug — warrants investigation.

**Long-term fix:** Add a field type predicate or `seriesFieldTypes` property to the panel plugin
descriptor (or thread through `PanelContext`), and have `seriesVisibilityConfigFactory` accept it
as a parameter rather than hard-coding the list. Panels already declare supported field types in
other contexts (e.g., `PanelPlugin.useFieldConfig()`); this would surface that information to the
right place.

---

## Suggested Forum Post Framing

1. **Immediate fix** — change `number` to `number | boolean | enum` in `grafana/scenes`
   (and Grafana repo for Explore). Point out PR #125048 only fixes Explore, not dashboards.

2. **Related fix** — `isTimeSeries()` in `decorators.ts` silently drops boolean/enum frames in
   Explore, so the Graph section never renders for those queries.

3. **Architectural concern** — knowledge about which field types are "series" belongs in the panel
   plugin, not in the scenes framework. Propose adding a predicate/property to the plugin API.

4. Offer to submit PRs to both `grafana/grafana` and `grafana/scenes` if the maintainers agree
   with the approach.

---

## Local Setup

- Scenes repo cloned at `/workspaces/scenes`
- Fix applied to scenes source; built with `yarn build` in `packages/scenes`
- Grafana uses the fixed scenes dist via direct copy:
  `cp -r /workspaces/scenes/packages/scenes/dist/* /workspaces/grafana/node_modules/@grafana/scenes/dist/`
- After copying, clear webpack cache before rebuilding:
  `rm -rf /workspaces/grafana/node_modules/.cache/webpack/grafana-default-production`
- Build directly (bypassing `nx exec` task cache):
  `NODE_ENV=production node --experimental-vm-modules ./node_modules/.bin/webpack --config scripts/webpack/webpack.prod.ts`
  `NODE_ENV=production node --experimental-vm-modules ./node_modules/.bin/webpack --config scripts/webpack/webpack.prod.ts --env react19=1`
- Restart backend after each build to pick up new `assets-manifest.json`

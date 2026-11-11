---
name: federal-reserve-guide
description: Use fedreserve_* tools to compare FRED indicators, choose level or growth transformations, trace a series to its release schedule, or analyze staged observations with DuckDB.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use FRED for published economic time series and release metadata. The server requires a FRED API key. Observations reflect the current FRED series, including revisions. If the task asks what was known on a past date, use a point-in-time source such as ALFRED. An observation date identifies the period measured.

## Identifiers

- Take the series ID from a search hit, a release's series list, or a category's series results. Follow child category IDs from the category browser when exploring a topic.
- Take a release ID from a release lookup or request the optional release mapping on the series metadata. For an ambiguous release name, match the intended publication to an alternative and retry with its exact ID.
- Take the staged table name from `dataset.name` in the observation response. The dataframe tools use the table name directly and have no `canvas_id`.

## Gates

- Check the series title, native units, frequency, and seasonal adjustment before comparing values. Compare rates at their published levels with `lin`. On a series measured in percent, `ch1` measures the difference from a year ago in percentage points, while `pc1` measures relative percent change. For year-over-year inflation from a price index, use `pc1`. Use the returned transformation label to interpret transformed values. The optional native unit describes the underlying series.
- Preserve `.` as missing and the returned text when reporting exact values. For the latest available numeric value, page newest first until you find one and report its observation date.
- Inspect failed and deferred IDs before reporting a comparison as complete. Request deferred IDs separately and resolve failures or disclose the gap. Before concluding a search, release, or category lacks a series, check result counts and remaining pages. If the FRED search window is exhausted, narrow the query or add filters.
- An unavailable release schedule leaves the date unknown. A successful empty schedule means FRED returned no upcoming dates. A scheduled release date and a series observation date describe different events.
- Use early dataframe deletion only when the user requests it and the deployment enables it. Check the exact table name before dropping it.

## Core chain

For unemployment and underemployment, use `fedreserve_search_series` to resolve the series and `fedreserve_get_series` to check that their rates and frequencies are comparable. Fetch the same date range at published levels with `fedreserve_get_observations` and compare matching periods. For the next release, request the series-to-release mapping with the metadata and pass its release ID to `fedreserve_get_release`.

## Workflows

### Page observations

Keep the series, date range, transformation, and sort order fixed while paging. Counts and date bounds describe the fetched page, even when the inline result shows a preview. If the preview is clipped and no dataset is available, re-fetch with smaller single-series pages to recover the omitted rows. For subsequent pages, advance the offset by that series' fetched observation count. Use this inline path on deployments without DuckDB, including the Claude Desktop bundle.

### Query staged observations

When observations are staged, pass the exact `dataset.name` to `fedreserve_dataframe_describe` before writing SQL with `fedreserve_dataframe_query`. A separate observation fetch that stages rows creates a fresh table in the same tenant's workspace. Keep both names to join results from separate fetches. Use the returned expiry for each table. Reads leave that deadline fixed, and a server restart clears staged tables. Re-fetch observations if the table is gone.

Use a single DuckDB SELECT, including CTEs, joins, or windows as needed. To pivot two rate series fetched together, substitute the table name you described and convert observation text before doing arithmetic.

```sql
SELECT date,
       MAX(TRY_CAST(NULLIF(value, '.') AS DOUBLE))
         FILTER (WHERE series_id = 'UNRATE') AS unemployment_rate,
       MAX(TRY_CAST(NULLIF(value, '.') AS DOUBLE))
         FILTER (WHERE series_id = 'U6RATE') AS underemployment_rate
FROM df_ABCDE_12345
GROUP BY date
ORDER BY date
```

Keep the SQL result's NULLs as missing. If the provider caps a query result, narrow the query or materialize the full result for a later query. A small inline preview can accompany a complete staged table.

# fred-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `fred_search_series` | Full-text search across FRED series titles, units, frequency, and tags. Returns matching series IDs with titles, units, frequency, and last-updated dates for use in follow-up observation or metadata calls. Supports post-search filtering by frequency, units, or seasonal adjustment status. To find series for a specific release, use `fred_get_release` instead. | `query` (text), `search_type?` (enum: full_text, series_id — default full_text), `filter_variable?` (enum: frequency, units, seasonal_adjustment), `filter_value?`, `tag_names?` (semicolon-delimited), `limit?`, `offset?` | `readOnlyHint: true`, `openWorldHint: true` |
| `fred_get_series` | Retrieves metadata for one or more FRED series — title, units, frequency, seasonal adjustment status, observation range, popularity, and notes. Accepts up to 50 series IDs; fires parallel upstream requests (no batch endpoint exists). | `series_ids` (string or string[≤50]) | `readOnlyHint: true`, `openWorldHint: false` |
| `fred_get_observations` | Fetches observation data (date + value pairs) for one or more FRED series over a date range. Fires one upstream request per series in parallel (no multi-series batch endpoint). Supports FRED's built-in unit transformations (`lin`, `chg`, `ch1`, `pch`, `pc1`, `pca`, `cch`, `cca`, `log`). Multi-series or >500-row results spill to a DataCanvas table for SQL querying. | `series_ids` (string or string[≤10]), `observation_start?` (ISO 8601 date), `observation_end?`, `units?` (enum), `frequency?` (enum), `aggregation_method?` (enum: avg/sum/eop), `canvas_id?` | `readOnlyHint: true`, `openWorldHint: false` |
| `fred_browse_categories` | Navigates the FRED category tree. Returns child categories and a sample of series when viewing a leaf. Provide `category_id` to drill down; omit to start at the root (ID 0). | `category_id?` (integer, default 0) | `readOnlyHint: true`, `openWorldHint: false` |
| `fred_get_release` | Returns metadata and associated series for a FRED release (e.g., Employment Situation, Consumer Price Index). Accepts a `release_id` integer or a name query — the name path fetches all releases via `/fred/releases` and matches client-side (FRED has no server-side release search). Returns release name, link, scheduled dates, and a paginated list of its series. | `release_id?` (integer), `release_search?` (text — case-insensitive substring match against release names; one of the two required), `series_limit?`, `series_offset?` | `readOnlyHint: true`, `openWorldHint: true` |

### Resources

No standalone resources — all data is reachable via the tool surface.

### Prompts

No prompts — the tool surface is self-sufficient for the domain's use cases.

---

## Overview

fred-mcp-server wraps the Federal Reserve Bank of St. Louis's FRED API, exposing ~800K economic time-series to agentic workflows. Users can resolve economic topics to series IDs, pull and compare observation data across date ranges, inspect release schedules and their constituent series, and navigate the category hierarchy. The primary audience is macro research workflows: analyzing rate environments, comparing price indices, correlating employment data with filing periods, or surfacing the latest data from a specific Fed release.

---

## Requirements

- Read-only access to the FRED public API (`api.stlouisfed.org/fred`)
- Free API key required (`FRED_API_KEY` env var); one key covers all tool calls
- Rate limit: 120 requests/minute per key — serial tool calls are well within limit; burst workflows (multi-series fetch) should batch where possible
- Observation data are date + value pairs in JSON; vintage (ALFRED) data deferred to v1+
- DataCanvas (Node + DuckDB, opt-in) used for multi-series observation spillover; tools degrade gracefully when `canvas_id` is unavailable (return inline preview + truncation notice)
- No write operations — the FRED API is read-only

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `FredApiService` | FRED REST API (`api.stlouisfed.org/fred/`) | All tools |

`FredApiService` handles API key injection, JSON parsing, retry with backoff, and 429 rate-limit detection. A single base-URL config point makes staging vs. production swappable.

**Resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Full fetch + parse pipeline per `withRetry` |
| Backoff | 1–2s base delay (API is rate-limited, not ephemeral) |
| 429 handling | Detect `429` response → `ServiceUnavailable`, retryable |
| Parse failure | Detect HTML error pages → transient error, not `SerializationError` |
| Pagination | `fred_get_release` series list and `fred_search_series` paginate via `offset`+`limit` (FRED's native params). `fred_get_observations` also supports `limit`/`offset` for very long series (default limit 100000 — effectively all rows for most series; explicit pagination only needed for ultra-long daily series). |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `FRED_API_KEY` | Yes | FRED API key from stlouisfed.org |
| `FRED_BASE_URL` | No | Override API base URL (default: `https://api.stlouisfed.org/fred`) |

Defined in `src/config/server-config.ts` as a Zod schema with `.env()` parsing.

---

## Implementation Order

1. Config (`server-config.ts`) — `FRED_API_KEY`, `FRED_BASE_URL`
2. `FredApiService` — base fetch, retry, 429 handling, key injection
3. `fred_search_series` — entry point for most workflows; tests search + filter paths
4. `fred_get_series` — metadata fetch, batch input (array of IDs)
5. `fred_get_observations` — observations + unit transform + DataCanvas spillover
6. `fred_browse_categories` — category tree traversal
7. `fred_get_release` — release lookup by ID or name search

Each step is independently testable against the live API.

---

## Error Contracts

Declared `errors` entries for domain failures (`ctx.fail` type-checked against these):

| Tool | reason | code | when | retryable? |
|:-----|:-------|:-----|:-----|:-----------|
| `fred_get_series` | `series_not_found` | `NotFound` | Series ID exists in format but FRED returns no data | Yes — verify ID |
| `fred_get_series` | `partial_failure` | `ServiceUnavailable` | Some IDs in a batch returned errors; partial results returned | Yes |
| `fred_get_observations` | `series_not_found` | `NotFound` | Series ID not found on FRED | Yes — verify ID |
| `fred_get_observations` | `frequency_too_high` | `InvalidParams` | Requested `frequency` aggregation is higher than the series native frequency | No — use lower frequency or omit |
| `fred_get_observations` | `no_observations_in_range` | `NotFound` | Valid series but date range contains no observations | No — expand range |
| `fred_get_release` | `release_not_found` | `NotFound` | `release_id` not found, or `release_search` matched no releases | Yes — try broader search or check ID |
| `fred_get_release` | `ambiguous_release_search` | `InvalidParams` | `release_search` matched multiple releases with similar names | No — use `release_id` instead |
| All tools | _(baseline)_ | `ServiceUnavailable` | FRED API 5xx, 429, or timeout | Yes — retried by service layer |

---

## Domain Mapping

| Noun | API Endpoints | Tools |
|:-----|:-------------|:------|
| Series | `/series`, `/series/search`, `/series/observations`, `/series/tags` | `fred_search_series`, `fred_get_series`, `fred_get_observations` |
| Category | `/category`, `/category/children`, `/category/series` | `fred_browse_categories` |
| Release | `/release`, `/releases` (fetched in full for name search, client-side filtered), `/release/series` | `fred_get_release` |
| Tag | Used internally in search filter; not surfaced as its own tool | — |

---

## Workflow Analysis

**Common chain: resolve → fetch → compare**

1. `fred_search_series(query="unemployment rate")` → returns `UNRATE` and related series IDs
2. `fred_get_series(series_ids=["UNRATE","U6RATE"])` → confirm title, units, frequency
3. `fred_get_observations(series_ids=["UNRATE","U6RATE"], observation_start="2020-01-01", units="pc1")` → YoY % change for both series (fires 2 parallel upstream calls); spills to canvas if row count > 500

**Release discovery chain**

1. `fred_get_release(release_search="Employment Situation")` → finds release ID + series list
2. `fred_get_series(series_ids=[...])` → narrow to relevant series (payrolls, UE rate)
3. `fred_get_observations(...)` → fetch latest cycle of data

**Multi-series call mechanics:** Both `fred_get_series` and `fred_get_observations` accept an array of IDs but FRED has no batch endpoint — each ID is one upstream call. Fire all calls in parallel via `Promise.allSettled`; report per-series failures without tanking the whole result (partial success pattern). For `fred_get_observations` with 10 series, that's 10 parallel requests; account for rate-limit accumulation against the 120 req/min budget.

**`format()` completeness:** `format()` must render all observation data the `structuredContent` output carries — date/value pairs, series labels, units, and the canvas ID (if spilled). Claude Desktop reads `content[]` from `format()`; Claude Code reads `structuredContent`. A thin `format()` that returns only a summary line leaves Desktop clients blind to the actual data.

`fred_get_observations` DataCanvas spillover:

| Condition | Behavior |
|:----------|:---------|
| Single series, short range | Inline observations array |
| Multi-series or >500 rows | Inline preview (first 20 rows) + `canvas_id` for SQL via `api-canvas` |
| `canvas_id` provided | Appends to existing canvas table |
| Canvas unavailable (Workers / DuckDB disabled) | Inline preview + truncation notice with row count |

---

## Known Limitations

- **ALFRED vintages**: Historical revised data (what was known at a past date) is not exposed in v1. FRED revisions are available but not the point-in-time vintage API.
- **BLS freshness edge**: Some series FRED republishes from BLS lag by one release cycle. For hard-deadline freshness, pair with a BLS source.
- **Rate limit**: 120 req/min per key. Parallel multi-tool workflows should be aware of accumulation across tools in the same session.
- **Observation precision**: FRED returns values as strings to preserve trailing zeros; the service layer preserves string fidelity in the schema rather than coercing to float, avoiding silent precision loss.

---

## Decisions Log

### Answered questions

- **ALFRED vintages in v1?** → Skipped. FRED alone covers the vast majority of use cases; ALFRED adds significant API surface complexity for marginal v1 value. Deferred to a future `fred_get_vintage` tool.
- **DataCanvas for multi-series observations?** → Yes. Multi-series + long date ranges can easily exceed context budget. `canvas_id` is opt-in on `fred_get_observations`; tool degrades to inline preview when DuckDB/canvas is unavailable.
- **Unit transformations: server-side or pass-through?** → Server-side via FRED's native `units` parameter. FRED supports `lin`, `chg`, `ch1`, `pch`, `pc1`, `pca`, `cch`, `cca`, `log` natively; delegating to the API avoids recomputing against potentially incomplete local data and is always correct relative to the full series history.
- **Curated "common asks" lookup baked in?** → Rely on search. A hardcoded mapping adds maintenance burden, goes stale, and is redundant once `fred_search_series` is working. The API's search is good enough for "unemployment rate" → `UNRATE`.
- **`fred_get_release`: separate "search release" and "get release" tools?** → Consolidated into one tool with either `release_id` or `release_search` required. The two paths have the same output contract; splitting adds surface without gain.
- **Tag browsing as a tool?** → Excluded from v1. Tags are already surfaced as a filter dimension on `fred_search_series`. A standalone tag-browser tool serves a niche workflow; defer unless requested.
- **Resource primitives?** → Skipped. All data is query-driven (series IDs aren't stable bookmarks the way a user profile URI would be); resources add no meaningful value for tool-only clients.
- **Prompts?** → Skipped. The domain is data retrieval; no recurring analysis templates justify a prompt primitive in v1.

### Options declined

- **Separate `fred_search_release` tool** → Folded into `fred_get_release` via optional `release_search` param. Two tools would mirror the same output contract for no user-facing benefit.
- **App tool for observation charts** → Declined. Heavy client dependency, most clients are tool-only, and chart rendering is better handled downstream by the agent or human in their own tooling.
- **Vintage/ALFRED surface** → Deferred. Significant added complexity; the base time series use case is fully covered without it.
- **Hardcoded series shortcut table** → Declined. Maintenance burden with no advantage over search; goes stale as FRED adds/retires series.
- **`fred_list_releases` as a standalone tool** → Declined. Release discovery via `fred_get_release(release_search=...)` covers the use case. A flat list of all releases (~300 entries) would be noisy without good filtering, and the search path is more natural.

### Post-design verification (API audit)

- **No batch endpoint for `/fred/series`** — confirmed by docs. `fred_get_series` with N IDs must fire N parallel requests via `Promise.allSettled`. Design updated to reflect this; partial success pattern required.
- **No release search endpoint** — confirmed. FRED exposes `/fred/releases` (returns all releases, limit 1000) and `/fred/release` (get by ID) but has no `/fred/releases/search`. The `release_search` path fetches all releases and filters client-side by name substring. Design updated; `fred_get_release` description now reflects this accurately.
- **`/fred/series/observations` is single-series** — confirmed. Multi-series in `fred_get_observations` = N parallel upstream calls. Design updated with parallel-call mechanics note in Workflow Analysis.
- **Units enum corrected** — FRED's actual unit codes: `lin`, `chg`, `ch1`, `pch`, `pc1`, `pca`, `cch`, `cca`, `log`. Tool surface previously said "pct change" (not a valid code); updated to enumerate all 9 codes explicitly. `pch` = Percent Change, `pc1` = Percent Change from Year Ago.
- **`filter_variable` enum for search** — confirmed: only `frequency`, `units`, `seasonal_adjustment` are valid. The prior description's mention of "release ID" filtering was incorrect — that's a separate call path via `fred_get_release`. Design updated.
- **`aggregation_method` parameter** — exists on `/fred/series/observations` (`avg`, `sum`, `eop`); relevant when downsampling frequency. Added to `fred_get_observations` inputs.
- **Observations pagination** — FRED default/max limit is 100,000 observations per call (effectively all rows for most series). Explicit `limit`/`offset` on observations only needed for ultra-long daily series. Service section updated.

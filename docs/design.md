# federal-reserve-mcp-server — Design

## MCP Surface

### Tools

5 tools (+1 opt-in dataframe drop):

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `fedreserve_search_series` | Full-text search across FRED series titles, units, frequency, and tags. Returns matching series IDs with titles, units, frequency, and last-updated dates for use in follow-up observation or metadata calls. Supports post-search filtering by frequency, units, or seasonal adjustment status. To find series for a specific release, use `fedreserve_get_release` instead. | `query` (text), `search_type?` (enum: full_text, series_id — default full_text), `filter_variable?` (enum: frequency, units, seasonal_adjustment), `filter_value?`, `tag_names?` (semicolon-delimited), `limit?`, `offset?` | `readOnlyHint: true`, `openWorldHint: true` |
| `fedreserve_get_series` | Retrieves metadata for one or more FRED series — title, units, frequency, seasonal adjustment status, observation range, popularity, and notes. Accepts up to 50 series IDs; fires parallel upstream requests (no batch endpoint exists). | `series_ids` (string or string[≤50]) | `readOnlyHint: true`, `openWorldHint: false` |
| `fedreserve_get_observations` | Fetches observation data (date + value pairs) for one or more FRED series over a date range. Fires one upstream request per series in parallel (no multi-series batch endpoint). Supports FRED's built-in unit transformations (`lin`, `chg`, `ch1`, `pch`, `pc1`, `pca`, `cch`, `cca`, `log`). Multi-series or >500-row results spill to a DataCanvas table and return a `df_<id>` handle for SQL querying. | `series_ids` (string or string[≤10]), `observation_start?` (ISO 8601 date), `observation_end?`, `units?` (enum), `frequency?` (enum), `aggregation_method?` (enum: avg/sum/eop), `canvas_id?` | `readOnlyHint: true`, `openWorldHint: false` |
| `fedreserve_browse_categories` | Navigates the FRED category tree. Returns child categories and a sample of series when viewing a leaf. Provide `category_id` to drill down; omit to start at the root (ID 0). | `category_id?` (integer, default 0) | `readOnlyHint: true`, `openWorldHint: false` |
| `fedreserve_get_release` | Returns metadata and associated series for a FRED release (e.g., Employment Situation, Consumer Price Index). Accepts a `release_id` integer or a name query — the name path fetches all releases via `/fred/releases` and matches client-side (FRED has no server-side release search). Returns release name, link, scheduled dates, and a paginated list of its series. | `release_id?` (integer), `release_search?` (text — case-insensitive substring match against release names; one of the two required), `series_limit?`, `series_offset?` | `readOnlyHint: true`, `openWorldHint: true` |
| `fedreserve_dataframe_describe` | List canvas dataframes materialized by `fedreserve_get_observations`, with provenance, TTL, schema, and row count. Read-only. | `name?` (df_\<id\> — omit to list all) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fedreserve_dataframe_query` | Run a single-statement SELECT across canvas dataframes. Supports joins, aggregates, window functions, and CTEs across any `df_<id>` handles you hold. `register_as` persists the result as a new dataframe with a fresh TTL. Writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected by the framework SQL gate. System catalogs are denied at the bridge layer. | `sql` (SELECT statement), `register_as?` (new df name), `preview?` (rows inline), `row_limit?` (default 1000, max 10000) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fedreserve_dataframe_drop` _(opt-in)_ | Drop a canvas dataframe by name. Idempotent — returns `dropped: false` when nothing matched. Exposed only when `FRED_DATAFRAME_DROP_ENABLED=true`; off by default since TTL handles cleanup. | `name` (df_\<id\>) | `readOnlyHint: false`, `idempotentHint: true`, `openWorldHint: false`, `destructiveHint: true` |

### Resources

No standalone resources — all data is reachable via the tool surface.

### Prompts

No prompts — the tool surface is self-sufficient for the domain's use cases.

---

## Overview

federal-reserve-mcp-server wraps the Federal Reserve Bank of St. Louis's FRED API, exposing ~800K economic time-series to agentic workflows. Users can resolve economic topics to series IDs, pull and compare observation data across date ranges, inspect release schedules and their constituent series, and navigate the category hierarchy. The primary audience is macro research workflows: analyzing rate environments, comparing price indices, correlating employment data with filing periods, or surfacing the latest data from a specific Fed release.

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
| `CanvasBridgeService` | Framework `DataCanvas` (`core.canvas`) | `fedreserve_get_observations`, `fedreserve_dataframe_describe`, `fedreserve_dataframe_query`, `fedreserve_dataframe_drop` |

`FredApiService` handles API key injection, JSON parsing, retry with backoff, and 429 rate-limit detection. A single base-URL config point makes staging vs. production swappable.

`CanvasBridgeService` is an adapter over the framework `DataCanvas`. Responsibilities:

- **`df_<id>` minting** — generates deterministic, opaque table names scoped to the current tenant and call.
- **All-nullable schema derivation** — FRED observation values are strings and can be `"."` (missing); the bridge derives a schema where every column is nullable so missing values don't fail registration.
- **Per-table TTL bookkeeping** — tracks provenance (source tool, query params, creation/expiry timestamps, truncation flag) alongside each registered dataframe. TTL slides on every bridge operation touching that table.
- **System-catalog SQL denial** — bridge-layer pre-check rejects queries that reference `information_schema`, `pg_catalog`, `sqlite_master`, or `duckdb_*` before the framework SQL gate sees them, preventing enumeration of dataframes the caller doesn't hold a handle for.

Implementation mirrors `src/services/canvas-bridge/` in secedgar-mcp-server.

**Resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Full fetch + parse pipeline per `withRetry` |
| Backoff | 1–2s base delay (API is rate-limited, not ephemeral) |
| 429 handling | Detect `429` response → `ServiceUnavailable`, retryable |
| Parse failure | Detect HTML error pages → transient error, not `SerializationError` |
| Pagination | `fedreserve_get_release` series list and `fedreserve_search_series` paginate via `offset`+`limit` (FRED's native params). `fedreserve_get_observations` also supports `limit`/`offset` for very long series (default limit 100000 — effectively all rows for most series; explicit pagination only needed for ultra-long daily series). |

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `FRED_API_KEY` | Yes | — | FRED API key from stlouisfed.org |
| `FRED_BASE_URL` | No | `https://api.stlouisfed.org/fred` | Override API base URL |
| `FRED_DATASET_TTL_SECONDS` | No | `86400` | Per-table sliding TTL for canvas-registered dataframes. Touched on every bridge op against that table. |
| `FRED_DATAFRAME_DROP_ENABLED` | No | `false` | Set to `true` to expose `fedreserve_dataframe_drop`. Off by default; TTL handles cleanup in normal operation. |
| `CANVAS_PROVIDER_TYPE` | No | `none` | Canvas engine. Set to `duckdb` to enable dataframe tools. Must be `duckdb` for `fedreserve_dataframe_*` tools to function; fails closed on Cloudflare Workers. |

Defined in `src/config/server-config.ts` as a Zod schema with `.env()` parsing.

---

## Implementation Order

1. Config (`server-config.ts`) — `FRED_API_KEY`, `FRED_BASE_URL`, `FRED_DATASET_TTL_SECONDS`, `FRED_DATAFRAME_DROP_ENABLED`
2. `FredApiService` — base fetch, retry, 429 handling, key injection
3. `fedreserve_search_series` — entry point for most workflows; tests search + filter paths
4. `fedreserve_get_series` — metadata fetch, batch input (array of IDs)
5. `fedreserve_get_observations` — observations + unit transform + DataCanvas spillover + `dataset` field in output
6. `fedreserve_browse_categories` — category tree traversal
7. `fedreserve_get_release` — release lookup by ID or name search
8. `CanvasBridgeService` — `df_<id>` minting, all-nullable schema derivation, per-table TTL, system-catalog SQL denial
9. `fedreserve_dataframe_describe` — list canvas dataframes with provenance and schema
10. `fedreserve_dataframe_query` — single-statement SELECT with optional `register_as` chaining
11. `fedreserve_dataframe_drop` _(opt-in)_ — conditional registration behind `FRED_DATAFRAME_DROP_ENABLED`

Steps 8–11 depend on `fedreserve_get_observations` (step 5) being operational so there are dataframes to test against. Each step is independently testable against the live API.

---

## Dataframe Tool Detail

### `fedreserve_dataframe_describe`

Lists all canvas dataframes registered by `fedreserve_get_observations` for the current tenant, with provenance and schema. Read-only; triggers a lazy sweep of expired tables before responding.

**Input:**
- `name?` — optional `df_<id>` to describe a single dataframe; omit to list all.

**Output per dataframe entry:**
- `name` — canvas table name (`df_XXXXX_XXXXX`)
- `source_tool` — tool that materialized this dataframe (always `fedreserve_get_observations` for v1)
- `query_params` — the input parameters the source call was made with (series IDs, date range, units, etc.)
- `created_at` / `expires_at` — ISO 8601 timestamps; TTL slides on every bridge op
- `row_count` — rows registered
- `truncated` / `max_rows?` — whether the upstream source was capped during materialization
- `column_schema` — `[{ name, type, nullable }]` — all columns nullable (FRED observations can be `"."`)

---

### `fedreserve_dataframe_query`

Runs a single SELECT against `df_<id>` tables on the shared canvas. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported.

**Input:**
- `sql` — single-statement SELECT. Reference dataframes by the `df_<id>` handles returned from `fedreserve_get_observations` or listed by `fedreserve_dataframe_describe`.
- `register_as?` — persist the result as a new dataframe. Must use `df_XXXXX_XXXXX` naming. The new dataframe gets a fresh TTL independent of the source tables.
- `preview?` — rows to include inline in the response (useful when chaining via `register_as`).
- `row_limit?` — hard cap on materialized rows (default 1000, max 10000). Use `register_as` to hold large results on-canvas rather than raising this.

**SQL gate (four layers, framework-enforced):**
1. Text-level deny-list — file/HTTP-reading table functions rejected before parse
2. Statement count — must be exactly 1
3. Statement type — must be `SELECT`
4. EXPLAIN-plan walk — denied-function rescan over plan metadata

**Bridge-layer additions:** `information_schema`, `pg_catalog`, `sqlite_master`, and `duckdb_*` catalog references are denied before the framework gate, so callers cannot enumerate dataframes they don't hold a handle for.

**BIGINT note:** FRED observation values are strings in the upstream API; the bridge schema uses `VARCHAR` for the `value` column. Numeric columns derived by `register_as` chaining (COUNT, SUM, etc.) may be `BIGINT` — serialize as JSON strings for values outside the JS `Number` range. `CAST(col AS DOUBLE)` in projections for inline arithmetic.

---

### `fedreserve_dataframe_drop` _(opt-in)_

Drops a canvas dataframe by name. Annotations: `readOnlyHint: false`, `idempotentHint: true`, `destructiveHint: true`.

- Opt-in via `FRED_DATAFRAME_DROP_ENABLED=true`. Not registered in `createApp()` unless the env var is set.
- Idempotent — returns `dropped: false` when the name doesn't match any active dataframe.
- TTL handles cleanup in normal operation; this tool is for explicit early reclamation when an analysis is complete.

---

## Error Contracts

Declared `errors` entries for domain failures (`ctx.fail` type-checked against these):

| Tool | reason | code | when | retryable? |
|:-----|:-------|:-----|:-----|:-----------|
| `fedreserve_get_series` | `series_not_found` | `NotFound` | Series ID exists in format but FRED returns no data | Yes — verify ID |
| `fedreserve_get_series` | `partial_failure` | `ServiceUnavailable` | Some IDs in a batch returned errors; partial results returned | Yes |
| `fedreserve_get_observations` | `series_not_found` | `NotFound` | Series ID not found on FRED | Yes — verify ID |
| `fedreserve_get_observations` | `frequency_too_high` | `InvalidParams` | Requested `frequency` aggregation is higher than the series native frequency | No — use lower frequency or omit |
| `fedreserve_get_observations` | `no_observations_in_range` | `NotFound` | Valid series but date range contains no observations | No — expand range |
| `fedreserve_get_release` | `release_not_found` | `NotFound` | `release_id` not found, or `release_search` matched no releases | Yes — try broader search or check ID |
| `fedreserve_get_release` | `ambiguous_release_search` | `InvalidParams` | `release_search` matched multiple releases with similar names | No — use `release_id` instead |
| All dataframe tools | `canvas_unavailable` | `ServiceUnavailable` | `CANVAS_PROVIDER_TYPE` is not `duckdb` | No — set env var and restart |
| All tools | _(baseline)_ | `ServiceUnavailable` | FRED API 5xx, 429, or timeout | Yes — retried by service layer |

---

## Domain Mapping

| Noun | API Endpoints | Tools |
|:-----|:-------------|:------|
| Series | `/series`, `/series/search`, `/series/observations`, `/series/tags` | `fedreserve_search_series`, `fedreserve_get_series`, `fedreserve_get_observations` |
| Category | `/category`, `/category/children`, `/category/series` | `fedreserve_browse_categories` |
| Release | `/release`, `/releases` (fetched in full for name search, client-side filtered), `/release/series` | `fedreserve_get_release` |
| Tag | Used internally in search filter; not surfaced as its own tool | — |

---

## Workflow Analysis

**Common chain: resolve → fetch → compare**

1. `fedreserve_search_series(query="unemployment rate")` → returns `UNRATE` and related series IDs
2. `fedreserve_get_series(series_ids=["UNRATE","U6RATE"])` → confirm title, units, frequency
3. `fedreserve_get_observations(series_ids=["UNRATE","U6RATE"], observation_start="2020-01-01", units="pc1")` → YoY % change for both series (fires 2 parallel upstream calls); spills to canvas if row count > 500

**Release discovery chain**

1. `fedreserve_get_release(release_search="Employment Situation")` → finds release ID + series list
2. `fedreserve_get_series(series_ids=[...])` → narrow to relevant series (payrolls, UE rate)
3. `fedreserve_get_observations(...)` → fetch latest cycle of data

**Multi-series call mechanics:** Both `fedreserve_get_series` and `fedreserve_get_observations` accept an array of IDs but FRED has no batch endpoint — each ID is one upstream call. Fire all calls in parallel via `Promise.allSettled`; report per-series failures without tanking the whole result (partial success pattern). For `fedreserve_get_observations` with 10 series, that's 10 parallel requests; account for rate-limit accumulation against the 120 req/min budget.

**`format()` completeness:** `format()` must render all observation data the `structuredContent` output carries — date/value pairs, series labels, units, and the `dataset` handle (if spilled). Claude Desktop reads `content[]` from `format()`; Claude Code reads `structuredContent`. A thin `format()` that returns only a summary line leaves Desktop clients blind to the actual data.

**Dataframe chain: cross-series SQL analytics**

1. `fedreserve_get_observations(series_ids=["UNRATE","CPIAUCSL"], observation_start="2010-01-01")` → spills both series to canvas; output includes `dataset: "df_abc12_def34"`
2. `fedreserve_dataframe_query(sql="SELECT date, MAX(CASE WHEN series_id='UNRATE' THEN value END) AS unrate, MAX(CASE WHEN series_id='CPIAUCSL' THEN value END) AS cpi FROM df_abc12_def34 GROUP BY date ORDER BY date")` → pivot both series into a single wide table
3. `fedreserve_dataframe_query(sql="SELECT date, AVG(unrate) OVER (ORDER BY date ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS rolling_12m_unrate FROM (...)")` → rolling window over the pivoted result
4. `fedreserve_dataframe_query(sql="...", register_as="df_xyz99_pqr77")` → persist the enriched analysis as a new dataframe with a fresh TTL for follow-up calls without re-running the source query

This chain enables YoY comparisons, rolling averages, JOIN across series at different frequencies, and aggregation to custom periods — all without re-fetching upstream data.

`fedreserve_get_observations` DataCanvas spillover:

| Condition | Behavior |
|:----------|:---------|
| Single series, short range | Inline observations array. No `dataset` field in output. |
| Multi-series or >500 rows | Inline preview (first 20 rows) + `dataset: "df_<id>"` in output. Pass the handle to `fedreserve_dataframe_query`. |
| `canvas_id` provided | Appends to existing canvas table; returns the same `dataset` handle. |
| Canvas unavailable (Workers / DuckDB disabled) | Inline preview + truncation notice with row count. No `dataset` field. |

The `dataset` field in the `fedreserve_get_observations` output schema is `string | undefined` — present only when spillover occurred. Agents should check for its presence before calling `fedreserve_dataframe_query`.

---

## Known Limitations

- **ALFRED vintages**: Historical revised data (what was known at a past date) is not exposed in v1. FRED revisions are available but not the point-in-time vintage API.
- **BLS freshness edge**: Some series FRED republishes from BLS lag by one release cycle. For hard-deadline freshness, pair with a BLS source.
- **Rate limit**: 120 req/min per key. Parallel multi-tool workflows should be aware of accumulation across tools in the same session.
- **Observation precision**: FRED returns values as strings to preserve trailing zeros; the service layer preserves string fidelity in the schema rather than coercing to float, avoiding silent precision loss.
- **Dataframe tools require `CANVAS_PROVIDER_TYPE=duckdb`**: DuckDB has no V8-isolate build; setting this on Cloudflare Workers fails closed with a `ConfigurationError` at init time. The three `fedreserve_dataframe_*` tools are Node-only in practice. `fedreserve_get_observations` degrades gracefully — it returns inline observations and a truncation notice when canvas is unavailable, with no `dataset` field in the output.
- **Canvas is in-memory only**: Server restart drops all registered dataframes. Re-run `fedreserve_get_observations` to re-register after a restart. Disk persistence is a framework v2 concern.

---

## Decisions Log

### Answered questions

- **ALFRED vintages in v1?** → Skipped. FRED alone covers the vast majority of use cases; ALFRED adds significant API surface complexity for marginal v1 value. Deferred to a future `fedreserve_get_vintage` tool.
- **DataCanvas for multi-series observations?** → Yes. Multi-series + long date ranges can easily exceed context budget. `canvas_id` is opt-in on `fedreserve_get_observations`; tool degrades to inline preview when DuckDB/canvas is unavailable.
- **Unit transformations: server-side or pass-through?** → Server-side via FRED's native `units` parameter. FRED supports `lin`, `chg`, `ch1`, `pch`, `pc1`, `pca`, `cch`, `cca`, `log` natively; delegating to the API avoids recomputing against potentially incomplete local data and is always correct relative to the full series history.
- **Curated "common asks" lookup baked in?** → Rely on search. A hardcoded mapping adds maintenance burden, goes stale, and is redundant once `fedreserve_search_series` is working. The API's search is good enough for "unemployment rate" → `UNRATE`.
- **`fedreserve_get_release`: separate "search release" and "get release" tools?** → Consolidated into one tool with either `release_id` or `release_search` required. The two paths have the same output contract; splitting adds surface without gain.
- **Tag browsing as a tool?** → Excluded from v1. Tags are already surfaced as a filter dimension on `fedreserve_search_series`. A standalone tag-browser tool serves a niche workflow; defer unless requested.
- **Resource primitives?** → Skipped. All data is query-driven (series IDs aren't stable bookmarks the way a user profile URI would be); resources add no meaningful value for tool-only clients.
- **Prompts?** → Skipped. The domain is data retrieval; no recurring analysis templates justify a prompt primitive in v1.
- **Why expose `fedreserve_dataframe_*` tools at all?** → The core value of this server is time-series analysis. The moment an agent fetches two or more series, the natural follow-up is a JOIN, rolling window, or YoY delta — none of which fit in a single tool call without canvas SQL. Inline arrays for 10 series × 5 years of monthly data (~600 rows each) would exceed context budgets for most clients. Canvas spillover with SQL tools lets agents do the analysis without re-fetching. The three dataframe tools are the minimum surface needed to make that workflow usable.
- **Why opt-in drop?** → TTL at `FRED_DATASET_TTL_SECONDS` (default 24h) is sufficient for normal workflows — re-fetching a time series is cheap and fast. `fedreserve_dataframe_drop` is destructive and irreversible within the TTL window; exposing it by default adds a footgun for no benefit in typical use. Operators who need explicit resource reclamation (long-running sessions, memory-constrained deployments) can opt in via the env var.
- **Why expose `register_as` chaining on `fedreserve_dataframe_query`?** → Multi-step economic analysis — pivot → aggregate → window function — hits DuckDB row limits if each step emits full results inline. `register_as` lets each step persist to canvas and hand a `df_<id>` token to the next step, without re-running earlier SQL. The alternative (a single mega-query) grows unreadable and is harder to debug. Chain depth is bounded by the per-tenant canvas cap and TTL.

### Options declined

- **Separate `fedreserve_search_release` tool** → Folded into `fedreserve_get_release` via optional `release_search` param. Two tools would mirror the same output contract for no user-facing benefit.
- **App tool for observation charts** → Declined. Heavy client dependency, most clients are tool-only, and chart rendering is better handled downstream by the agent or human in their own tooling.
- **Vintage/ALFRED surface** → Deferred. Significant added complexity; the base time series use case is fully covered without it.
- **Hardcoded series shortcut table** → Declined. Maintenance burden with no advantage over search; goes stale as FRED adds/retires series.
- **`fedreserve_list_releases` as a standalone tool** → Declined. Release discovery via `fedreserve_get_release(release_search=...)` covers the use case. A flat list of all releases (~300 entries) would be noisy without good filtering, and the search path is more natural.

### Post-design verification (API audit)

- **No batch endpoint for `/fred/series`** — confirmed by docs. `fedreserve_get_series` with N IDs must fire N parallel requests via `Promise.allSettled`. Design updated to reflect this; partial success pattern required.
- **No release search endpoint** — confirmed. FRED exposes `/fred/releases` (returns all releases, limit 1000) and `/fred/release` (get by ID) but has no `/fred/releases/search`. The `release_search` path fetches all releases and filters client-side by name substring. Design updated; `fedreserve_get_release` description now reflects this accurately.
- **`/fred/series/observations` is single-series** — confirmed. Multi-series in `fedreserve_get_observations` = N parallel upstream calls. Design updated with parallel-call mechanics note in Workflow Analysis.
- **Units enum corrected** — FRED's actual unit codes: `lin`, `chg`, `ch1`, `pch`, `pc1`, `pca`, `cch`, `cca`, `log`. Tool surface previously said "pct change" (not a valid code); updated to enumerate all 9 codes explicitly. `pch` = Percent Change, `pc1` = Percent Change from Year Ago.
- **`filter_variable` enum for search** — confirmed: only `frequency`, `units`, `seasonal_adjustment` are valid. The prior description's mention of "release ID" filtering was incorrect — that's a separate call path via `fedreserve_get_release`. Design updated.
- **`aggregation_method` parameter** — exists on `/fred/series/observations` (`avg`, `sum`, `eop`); relevant when downsampling frequency. Added to `fedreserve_get_observations` inputs.
- **Observations pagination** — FRED default/max limit is 100,000 observations per call (effectively all rows for most series). Explicit `limit`/`offset` on observations only needed for ultra-long daily series. Service section updated.

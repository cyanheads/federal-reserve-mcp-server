# federal-reserve-mcp-server — Design

## MCP Surface

### Tools

7 tools (+1 opt-in dataframe drop):

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `fedreserve_search_series` | Full-text search across FRED series titles, units, frequency, and tags. Returns matching series IDs with titles, units, frequency, and last-updated dates for use in follow-up observation or metadata calls. Supports post-search filtering by frequency, units, or seasonal adjustment status. To find series for a specific release, use `fedreserve_get_release` instead. | `query` (text), `search_type?` (enum: full_text, series_id — default full_text), `filter_variable?` (enum: frequency, units, seasonal_adjustment), `filter_value?`, `tag_names?` (semicolon-delimited), `limit?`, `offset?` | `readOnlyHint: true`, `openWorldHint: true` |
| `fedreserve_get_series` | Retrieves metadata and optional release mapping. Normalizes and deduplicates IDs, processes the first 50 unique IDs, and returns excess IDs in `deferred_ids`. | `series_ids` (string, comma-separated string, or array; up to 100 IDs by default), `include_release?` (default false) | `readOnlyHint: true`, `openWorldHint: true` |
| `fedreserve_get_observations` | Fetches date/value observations and optional native-unit metadata for up to 10 processed series; excess IDs are deferred. Multi-series or >500-row results spill to a fresh DataCanvas table. Previews show the newest fetched rows without changing full-page counts or bounds. | `series_ids` (up to 100 by default), `observation_start?`, `observation_end?`, `units?`, `frequency?`, `aggregation_method?`, `sort_order?` (asc/desc), `limit?` (1–100000 per series), `offset?` | `readOnlyHint: true`, `openWorldHint: true` |
| `fedreserve_browse_categories` | Navigates the FRED category tree. Leaf categories return a popularity-descending page and upstream series total; non-leaves retain child navigation. | `category_id?` (default 0), `series_limit?` (default 10, max 1000), `series_offset?` | `readOnlyHint: true`, `openWorldHint: true` |
| `fedreserve_get_release` | Returns metadata and associated series for a FRED release (e.g., Employment Situation, Consumer Price Index). Accepts a `release_id` integer or a name query — the name path fetches all releases via `/fred/releases` and matches client-side (FRED has no server-side release search). Returns release name, link, scheduled dates, and a paginated list of its series. | `release_id?` (integer), `release_search?` (text — case-insensitive substring match against release names; one of the two required), `series_limit?`, `series_offset?` | `readOnlyHint: true`, `openWorldHint: true` |
| `fedreserve_dataframe_describe` | List canvas dataframes materialized by `fedreserve_get_observations`, with provenance, TTL, schema, and row count. Read-only. | `name?` (df_\<id\> — omit to list all) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fedreserve_dataframe_query` | Run a single-statement SELECT across canvas dataframes. Supports joins, aggregates, window functions, and CTEs across any `df_<id>` handles you hold. `register_as` persists the result as a new dataframe with a fresh TTL. Writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected by the framework SQL gate. System catalogs are denied at the bridge layer. | `sql` (SELECT statement), `register_as?` (new df name), `preview?` (rows inline), `row_limit?` (default 1000, max 10000) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `fedreserve_dataframe_drop` _(opt-in)_ | Drop a canvas dataframe by name. Idempotent — returns `dropped: false` when nothing matched. Exposed only when `FRED_DATAFRAME_DROP_ENABLED=true`; off by default since TTL handles cleanup. | `name` (df_\<id\>) | `readOnlyHint: false`, `idempotentHint: true`, `openWorldHint: false`, `destructiveHint: true` |

Search filter pairs are atomic: both members must be present and nonblank. Values are trimmed; known frequency and seasonal-adjustment values use FRED's casing, and frequency labels reduce to their base word. Units remain exact and case-sensitive. Search defaults to 20 rows; the final reachable page starts at offset 4000 and can request 1000 rows. Empty-page, exact-match and search-window guidance reaches both output surfaces.

Observation date inputs require calendar-valid `YYYY-MM-DD` dates; empty optional dates are unset and reversed dates fail before fetching. Each successful series reports the full fetched page's minimum/maximum dates before preview slicing, or `null` bounds when empty. A single empty series retains `no_observations_in_range`; a successful empty batch skips canvas. An entirely failed batch throws `partial_failure`. Aggregation without frequency returns a notice because FRED ignores the aggregation setting.

Release schedules request up to five dates on or after today in UTC, including dates without data, in ascending order. Historical dates are filtered from the returned schedule. Unavailable schedules set `scheduled_dates_unavailable`, distinct from an empty successful schedule. Category and release series lists are ordered by popularity descending upstream, so paging follows the same ordering.

### Resources

`skill://federal-reserve-guide/SKILL.md` serves the published workflow guide. Economic data remains query-driven through tools; there are no standalone data resources.

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
- DataCanvas (Node + DuckDB, on by default; `CANVAS_PROVIDER_TYPE=none` disables it) used for multi-series observation spillover; tools degrade gracefully when DataCanvas is unavailable (return inline preview + truncation notice)
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
- **Per-table TTL bookkeeping** — tracks provenance (source tool, query params, creation/expiry timestamps, truncation flag) alongside each registered dataframe. Expiry is fixed at creation; operations lazily remove expired tables without renewing them.
- **Shared tenant canvas** — `DataCanvas.acquireShared` serializes first acquisition. Replacing an expired or absent canvas clears this tenant's stale provenance; describe, drop, and sweeps never create a canvas.
- **Derived schemas** — `register_as` reads the named materialized table's `engineType` and nullability, preserving typed NULLs and empty-table schemas.
- **System-catalog SQL denial** — bridge-layer pre-check rejects queries that reference `information_schema`, `pg_catalog`, `sqlite_master`, or `duckdb_*` before the framework SQL gate sees them, preventing enumeration of dataframes the caller doesn't hold a handle for.

Implementation mirrors `src/services/canvas-bridge/` in secedgar-mcp-server.

**Resilience:**

| Concern | Decision |
|:--------|:---------|
| Retry boundary | Fetch and body read share a 15-second attempt timeout; transient retries share a 45-second deadline. Parse completed JSON outside retries. |
| Backoff | 1.5-second base delay, with valid Retry-After preserved. |
| HTTP errors | Exact FRED missing-entity/frequency messages carry typed reasons. Other 400s retain safe validation text. 429, unavailable upstream and timeout codes remain distinct; raw bodies and credential-bearing URLs are never exposed. |
| Parse failure | Completed invalid JSON or HTML returns `SerializationError` without retrying. |
| Optional reads | Native units, series-release mapping, and schedules use one two-second attempt. Caller cancellation propagates; availability failures omit secondary data and disclose missing release mappings or schedules. |
| Pagination | Search, leaf-category series, release series and observations expose upstream paging. Observation paging applies per series; preview counts never replace fetched counts. |

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `FRED_API_KEY` | Yes | — | FRED API key from stlouisfed.org |
| `FRED_BASE_URL` | No | `https://api.stlouisfed.org/fred` | Override API base URL |
| `FRED_DATASET_TTL_SECONDS` | No | `86400` | Dataframe lifetime from creation, in seconds. Reads do not renew expiry. |
| `FRED_DATAFRAME_DROP_ENABLED` | No | `false` | Set to `true` to expose `fedreserve_dataframe_drop`. Off by default; TTL handles cleanup in normal operation. |
| `FRED_CLAMP_LIMITS` | No | `true` | Accept up to 100 supplied IDs, normalize/deduplicate, process 10 observation IDs or 50 metadata IDs, and return the rest as `deferred_ids`. False restores strict 10/50 input limits. Deferrals are logged and counted. |
| `CANVAS_PROVIDER_TYPE` | No | `duckdb` | Canvas engine backing the `fedreserve_dataframe_*` tools. `src/index.ts` applies the default after `.env` loads, so an unset or empty value resolves to `duckdb`; `none` disables the tools. `duckdb` fails closed on Cloudflare Workers. |

Defined in `src/config/server-config.ts` as a Zod schema with `.env()` parsing.

---

## Implementation Order

1. Config (`server-config.ts`) — `FRED_API_KEY`, `FRED_BASE_URL`, `FRED_DATASET_TTL_SECONDS`, `FRED_DATAFRAME_DROP_ENABLED`, `FRED_CLAMP_LIMITS`
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
- `source_tool` — tool that materialized this dataframe (`fedreserve_get_observations` or `fedreserve_dataframe_query`)
- `query_params` — the input parameters the source call was made with (series IDs, date range, units, etc.)
- `created_at` / `expires_at` — ISO 8601 timestamps; expiry is fixed when the table is created
- `row_count` — rows registered
- `truncated` / `max_rows?` — whether the upstream source was capped during materialization
- `column_schema` — `[{ name, type, nullable }]`; observation columns are nullable, while registered SQL results use materialized DuckDB metadata

---

### `fedreserve_dataframe_query`

Runs a single SELECT against `df_<id>` tables on the shared canvas. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported.

**Input:**
- `sql` — single-statement SELECT. Reference dataframes by the `df_<id>` handles returned from `fedreserve_get_observations` or listed by `fedreserve_dataframe_describe`.
- `register_as?` — persist the result as a new dataframe. Must use `df_XXXXX_XXXXX` naming. The new dataframe gets a fresh TTL independent of the source tables.
- `preview?` — rows to include inline in the response (useful when chaining via `register_as`).
- `row_limit?` — cap on returned rows (default 1000, max 10000). `register_as` materializes the full result; `preview` bounds its inline sample, including zero.

An actual provider cap emits `truncated: true` and omits `totalCount`, which would otherwise imply a known full count. An exact-limit result or smaller inline preview retains the exact count. SQL NULL-containing rows use JSON rendering so NULL, empty strings, and the literal text `null` remain distinct.

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

- Opt-in via `FRED_DATAFRAME_DROP_ENABLED=true`; otherwise the tool remains registered as disabled.
- Idempotent — returns `dropped: false` when the name doesn't match any active dataframe.
- TTL handles cleanup in normal operation; this tool is for explicit early reclamation when an analysis is complete.

---

## Error Contracts

Declared `errors` entries for domain failures (`ctx.fail` type-checked against these):

| Tool | reason | code | when | retryable? |
|:-----|:-------|:-----|:-----|:-----------|
| `fedreserve_get_series` | `series_not_found` | `NotFound` | Series ID exists in format but FRED returns no data | Yes — verify ID |
| Both series tools | `partial_failure` | `ServiceUnavailable` | Every processed ID in a batch failed | Retry failed IDs individually |
| Both series tools | `invalid_series_ids` | `ValidationError` | No normalized IDs, or the accepted batch limit was exceeded | No — correct the supplied IDs |
| `fedreserve_get_observations` | `series_not_found` | `NotFound` | Series ID not found on FRED | Yes — verify ID |
| `fedreserve_get_observations` | `frequency_too_high` | `ValidationError` | Requested `frequency` aggregation is higher than the series native frequency | No — use lower frequency or omit |
| `fedreserve_get_observations` | `invalid_observation_range` | `ValidationError` | Start date is after end date | No — correct the date order |
| `fedreserve_get_observations` | `no_observations_in_range` | `NotFound` | Valid series but date range contains no observations | No — expand range |
| `fedreserve_search_series` | `invalid_filter` | `ValidationError` | A filter member is supplied without a complete nonblank pair | No — supply both members or omit both |
| `fedreserve_get_release` | `release_not_found` | `NotFound` | `release_id` not found, or `release_search` matched no releases | Yes — try broader search or check ID |
| `fedreserve_get_release` | `ambiguous_release_search` | `ValidationError` | `release_search` matched multiple releases with similar names | No — use `release_id` instead |
| All dataframe tools | `canvas_unavailable` | `ServiceUnavailable` | `CANVAS_PROVIDER_TYPE` is not `duckdb` | No — set env var and restart |
| FRED tools | _(baseline)_ | `ServiceUnavailable` / `RateLimited` / `Timeout` | Upstream availability failure | Transient primary requests retry within their deadline |

---

## Domain Mapping

| Noun | API Endpoints | Tools |
|:-----|:-------------|:------|
| Series | `/series`, `/series/search`, `/series/observations`, `/series/release` | `fedreserve_search_series`, `fedreserve_get_series`, `fedreserve_get_observations` |
| Category | `/category`, `/category/children`, `/category/series` | `fedreserve_browse_categories` |
| Release | `/release`, `/releases` (fetched in full for name search, client-side filtered), `/release/series` | `fedreserve_get_release` |
| Tag | Used internally in search filter; not surfaced as its own tool | — |

---

## Workflow Analysis

**Common chain: resolve → fetch → compare**

1. `fedreserve_search_series(query="unemployment rate")` → returns `UNRATE` and related series IDs
2. `fedreserve_get_series(series_ids=["UNRATE","U6RATE"])` → confirm title, units, frequency
3. `fedreserve_get_observations(series_ids=["UNRATE","U6RATE"], observation_start="2020-01-01", units="lin")` → published unemployment rates, with native units checked beside the values; the nonempty multi-series result spills to canvas

**Release discovery chain**

1. `fedreserve_get_release(release_search="Employment Situation")` → finds release ID + series list
2. `fedreserve_get_series(series_ids=[...])` → narrow to relevant series (payrolls, UE rate)
3. `fedreserve_get_observations(...)` → fetch latest cycle of data

**Multi-series call mechanics:** Both `fedreserve_get_series` and `fedreserve_get_observations` accept an array of IDs but FRED has no batch endpoint — each ID is one upstream call. Fire all calls in parallel via `Promise.allSettled`; report per-series failures without tanking the whole result (partial success pattern). For `fedreserve_get_observations` with 10 series, that's 10 parallel requests; account for rate-limit accumulation against the 120 req/min budget.

**`format()` completeness:** `format()` must render all observation data the `structuredContent` output carries — date/value pairs, series labels, units, and the `dataset` handle (if spilled). Claude Desktop reads `content[]` from `format()`; Claude Code reads `structuredContent`. A thin `format()` that returns only a summary line leaves Desktop clients blind to the actual data.

**Dataframe chain: cross-series SQL analytics**

1. `fedreserve_get_observations(series_ids=["UNRATE","CPIAUCSL"], observation_start="2010-01-01")` → spills both series to canvas; output includes `dataset.name`, such as `df_ABC12_DEF34`
2. Describe the returned table, then call `fedreserve_dataframe_query` with `sql="SELECT date, MAX(CASE WHEN series_id='UNRATE' THEN TRY_CAST(NULLIF(value, '.') AS DOUBLE) END) AS unrate, MAX(CASE WHEN series_id='CPIAUCSL' THEN TRY_CAST(NULLIF(value, '.') AS DOUBLE) END) AS cpi FROM df_ABC12_DEF34 GROUP BY date"` and `register_as="df_PIVOT_00001"` to persist a numeric pivot with missing values preserved as NULL.
3. Describe `df_PIVOT_00001`, then query `SELECT date, AVG(unrate) OVER (ORDER BY date ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS rolling_12m_unrate FROM df_PIVOT_00001 ORDER BY date` for a rolling window. Verify monthly spacing before treating 12 rows as 12 months.
4. Use `register_as` again to persist the enriched analysis as a fresh dataframe for follow-up calls without re-running the source query.

This chain enables YoY comparisons, rolling averages, JOIN across series at different frequencies, and aggregation to custom periods — all without re-fetching upstream data.

`fedreserve_get_observations` DataCanvas spillover:

| Condition | Behavior |
|:----------|:---------|
| Single series, short range | Inline observations array. No `dataset` field in output. |
| Multi-series or >500 rows | Up to 20 newest fetched rows distributed across series in requested order + `dataset.name` for a fresh table. Describe its schema, then query it with SELECT. |
| Repeated observation fetch | Registers a fresh table; previous dataframes remain unchanged. |
| Canvas unavailable (Workers / DuckDB disabled) | Newest fetched inline preview + paging guidance with fetched row counts. No `dataset` field. |

The optional `dataset` object carries `name`, `row_count`, `expires_at`, actual `preview_rows`, and `truncated`. After successful registration, a shared `notice` reaches both response surfaces: call `fedreserve_dataframe_describe` with `{"name":"<dataset.name>"}`, then `fedreserve_dataframe_query` with `{"sql":"SELECT * FROM <dataset.name>"}`. No staging notice is returned when registration fails or canvas is disabled.

---

## Known Limitations

- **ALFRED vintages**: Historical revised data (what was known at a past date) is not exposed in v1. FRED revisions are available but not the point-in-time vintage API.
- **BLS freshness edge**: Some series FRED republishes from BLS lag by one release cycle. For hard-deadline freshness, pair with a BLS source.
- **Rate limit**: 120 req/min per key. Parallel multi-tool workflows should be aware of accumulation across tools in the same session.
- **Observation precision**: FRED returns values as strings to preserve trailing zeros; the service layer preserves string fidelity in the schema rather than coercing to float, avoiding silent precision loss.
- **Dataframe tools need DuckDB**: DuckDB has no V8-isolate build; `CANVAS_PROVIDER_TYPE=duckdb` on Cloudflare Workers fails closed with a `ConfigurationError` at init time. The three `fedreserve_dataframe_*` tools are Node-only in practice, and the Claude Desktop bundle, whose DuckDB native bindings are stripped, pins `CANVAS_PROVIDER_TYPE=none`. `fedreserve_get_observations` degrades gracefully — it returns inline observations and a truncation notice when canvas is unavailable, with no `dataset` field in the output.
- **Canvas is in-memory only**: Server restart drops all registered dataframes. Re-run `fedreserve_get_observations` to re-register after a restart. Disk persistence is a framework v2 concern.

---

## Decisions Log

### Answered questions

- **ALFRED vintages in v1?** → Skipped. FRED alone covers the vast majority of use cases; ALFRED adds significant API surface complexity for marginal v1 value. Deferred to a future `fedreserve_get_vintage` tool.
- **DataCanvas for multi-series observations?** → Yes. Multi-series + long date ranges can easily exceed context budget. Each spill registers a fresh table; the tool degrades to inline preview when DuckDB/canvas is unavailable. Appending is not exposed because registration replaces rows rather than appending them.
- **DataCanvas on by default?** → Yes. `@duckdb/node-api` is a direct dependency, so npm, Docker, and source installs carry the runtime. After loading `.env`, `src/index.ts` applies `duckdb` when the normalized setting is unset. The MCPB bundle pins `none` because its native bindings are stripped.
- **Optional release mapping and native units?** → Release mapping is opt-in to avoid doubling metadata calls when the caller does not need a schedule. Native units accompany observations on a short, parallel attempt; a slow secondary endpoint cannot hold the primary result through retries.
- **Newest preview with full-page counts?** → Latest observations answer common current-value questions while preserving the fetched dataset for SQL and pagination. The preview is a presentation slice, never a substitute for the fetched row count.
- **Unit transformations: server-side or pass-through?** → Server-side via FRED's native `units` parameter. FRED supports `lin`, `chg`, `ch1`, `pch`, `pc1`, `pca`, `cch`, `cca`, `log` natively; delegating to the API avoids recomputing against potentially incomplete local data and is always correct relative to the full series history.
- **Curated "common asks" lookup baked in?** → Rely on search. A hardcoded mapping adds maintenance burden, goes stale, and is redundant once `fedreserve_search_series` is working. The API's search is good enough for "unemployment rate" → `UNRATE`.
- **`fedreserve_get_release`: separate "search release" and "get release" tools?** → Consolidated into one tool with either `release_id` or `release_search` required. The two paths have the same output contract; splitting adds surface without gain.
- **Tag browsing as a tool?** → Excluded from v1. Tags are already surfaced as a filter dimension on `fedreserve_search_series`. A standalone tag-browser tool serves a niche workflow; defer unless requested.
- **Data resources?** → Economic data remains query-driven through tools. The workflow guide is served as a skill resource so direct MCP clients can discover the same identifier and analysis guidance as plugin clients.
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

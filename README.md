<div align="center">
  <h1>federal-reserve-mcp-server</h1>
  <p><b>Search and fetch ~800K Federal Reserve economic time-series from the FRED API via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/federal-reserve-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/federal-reserve-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/federal-reserve-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/federal-reserve-mcp-server/releases/latest/download/federal-reserve-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=federal-reserve-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmVkZXJhbC1yZXNlcnZlLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22federal-reserve-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffederal-reserve-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Economic data from FRED, the St. Louis Fed's database of ~800K time series on output, prices, employment, money, rates, housing, and trade. Search series, pull observations, browse categories and releases, and run SQL over large results.

### Tools

| Tool | Description |
|:-----|:------------|
| `fedreserve_search_series` | Full-text search across FRED series titles, tags, and notes |
| `fedreserve_get_series` | Fetch metadata for one or more series — title, units, frequency, observation range |
| `fedreserve_get_observations` | Fetch date+value observations for one or more series, with date-range and unit-transform filtering |
| `fedreserve_browse_categories` | Navigate the FRED category tree |
| `fedreserve_get_release` | Look up a FRED release by ID or name search, with its associated series |
| `fedreserve_dataframe_describe` | List active DataCanvas dataframes with provenance, schema, and row count |
| `fedreserve_dataframe_query` | Run a SELECT against registered DataCanvas dataframes via DuckDB SQL |
| `fedreserve_dataframe_drop` | Drop a DataCanvas dataframe by name (opt-in) |

## Capability reference

The [FRED workflow guide](./skills/federal-reserve-guide/SKILL.md) covers indicator comparisons, release schedules, observation paging, and SQL over staged data. It ships with plugin, npm, Docker, and desktop-bundle installs and is available as the MCP resource `skill://federal-reserve-guide/SKILL.md`.

### `fedreserve_search_series` <sub>tool</sub>

- Full-text or series-ID search, with `frequency`, `units`, `seasonal_adjustment`, and `tag_names` filters; `filter_variable` and `filter_value` must be supplied together or the call returns `invalid_filter`
- Pagination via `limit` (default 20, max 1000). FRED accepts a maximum starting `offset` of 4000; use `offset: 4000, limit: 1000` for the final search-window page. Narrow the query or add filters to reach matches beyond that window.
- Frequency and seasonal-adjustment filter values are trimmed and normalized to FRED's casing; full frequency labels reduce to their base word. Units filters remain exact and case-sensitive.
- Output includes `active_filters` and `popularity` (0–100) when available; empty results suggest a broader query or category browsing

---

### `fedreserve_get_series` <sub>tool</sub>

- Accepts an ID, comma-separated IDs, or an array; trims, uppercases, and deduplicates IDs. Processes 50 unique IDs and returns the remainder in `deferred_ids` (up to 100 supplied IDs by default).
- Returns title, units, frequency, seasonal adjustment, observation range, popularity, and notes per series
- Failed IDs in a batch land in a `failed` array with FRED's safe error text; a genuinely missing single ID throws `series_not_found`, while validation and upstream availability errors retain their codes. An entirely failed batch throws `partial_failure`.
- `include_release: true` adds the release ID and name for each successful series through one optional bounded lookup. Pass its ID to `fedreserve_get_release` for the schedule; unavailable mappings are disclosed in a notice.

---

### `fedreserve_get_observations` <sub>tool</sub>

- Normalizes IDs like `fedreserve_get_series`, processes 10 unique IDs, and returns excess IDs in `deferred_ids`. Accepts `observation_start` / `observation_end` (`YYYY-MM-DD`), unit transforms, and frequency downsampling via `aggregation_method` (`avg`, `sum`, `eop`). Reversed dates fail before fetching; aggregation without a frequency adds a notice.
- `sort_order` (`asc` by default), `limit` (1–100000), and `offset` apply upstream to each series. Omitting paging controls retains the full fetch. For the latest three observations, use `sort_order: "desc", limit: 3`; `offset: 3` gets the next three.
- Returns date/value observations (strings preserve trailing zeros), transform code `units`, transform description `units_label`, optional native `series_units`, and per-series failures. An entirely failed batch throws `partial_failure`.
- Multi-series or >500-row results go to a DataCanvas table with a 20-row preview distributed across series. Previews select the newest fetched rows in the requested order; counts and date bounds describe the entire fetched page. The `notice` names `dataset.name` and executable describe/query calls. Without canvas, the inline preview includes paging guidance. Advance a follow-up offset by each series' fetched `observation_count`, not its preview length.

---

### `fedreserve_browse_categories` <sub>tool</sub>

- Omit `category_id` to start at the root (ID 0); returns the category and its children. Leaf categories return popularity-descending `sample_series`, paged by `series_limit` (default 10, max 1000) and `series_offset`, plus the upstream `series_count` even on empty pages.
- An unknown `category_id` throws `category_not_found`

---

### `fedreserve_get_release` <sub>tool</sub>

- Takes exactly one of `release_id` or `release_search` (case-insensitive name substring)
- Returns release name, link, notes, the next five scheduled dates, and a popularity-descending series list (`series_limit` default 20, max 1000; `series_offset`). A failed optional schedule request sets `scheduled_dates_unavailable`; an empty successful schedule remains distinct.
- An ambiguous name returns up to 10 `search_alternatives`; retry with the exact `release_id`

---

### `fedreserve_dataframe_describe` <sub>tool</sub>

- Lists active DataCanvas dataframes, newest first, or one by `name`
- Each entry carries `source_tool`, `query_params`, `created_at`, `expires_at`, `row_count`, `truncated` / `max_rows`, and `column_schema`

---

### `fedreserve_dataframe_query` <sub>tool</sub>

- Runs one read-only DuckDB SELECT against `df_<id>` tables (joins, aggregates, window functions, CTEs); external files, system catalogs, and engine-setting functions are blocked
- Use `range()` and `generate_series()` with constant arguments. Avoid DuckDB metadata names such as `duckdb_tables` for columns, aliases, CTEs, and staged tables. Qualify a column named `current_schema` with its table alias.
- `row_limit` caps returned rows (default 1000, max 10000) and `preview` sets the inline sample; BIGINT results serialize as strings
- Actual provider caps return `truncated: true` and omit `totalCount` because the full count is unknown; a smaller inline preview alone does not imply truncation. Use a narrower query or `register_as` to retain the complete result.
- `register_as` saves the full result as a new dataframe with its own TTL and materialized DuckDB column types, even when `preview: 0`. SQL NULL values remain distinct from empty strings and the text `null` in both response formats.

---

### `fedreserve_dataframe_drop` <sub>tool</sub>

- Opt-in: enabled by `FRED_DATAFRAME_DROP_ENABLED=true`, otherwise registered as disabled
- Drops the named dataframe early; returns `dropped: false` when it doesn't exist

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FRED-specific:

- Requires a `FRED_API_KEY` for the FRED API (up to 120 requests/minute)
- Unit transforms and frequency downsampling run on FRED's side against the full series history
- Large observation results spill to DataCanvas tables you can query with SQL
- DataCanvas runs on DuckDB by default; with `CANVAS_PROVIDER_TYPE=none`, the dataframe tools report `canvas_unavailable`

Agent-friendly output:

- Partial failures: `fedreserve_get_series` and `fedreserve_get_observations` retain successful series and per-ID failures; an entirely failed batch returns an error
- Ambiguous release names return `search_alternatives` instead of a guess
- Every dataframe carries `source_tool`, `query_params`, and TTL fields
- Without DataCanvas, `fedreserve_get_observations` returns a truncated inline preview with an explanatory `message`

## Getting started

Get a free [FRED API key](https://research.stlouisfed.org/docs/api/api_key.html), then add the server to Claude Code.

```sh
claude mcp add federal-reserve-mcp-server -e FRED_API_KEY=your-api-key -- npx -y @cyanheads/federal-reserve-mcp-server
```

For other MCP clients, add this to the client's configuration file.

```json
{
  "mcpServers": {
    "federal-reserve-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/federal-reserve-mcp-server"],
      "env": { "FRED_API_KEY": "your-api-key" }
    }
  }
}
```

For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `FRED_API_KEY` | **Required.** API key from [stlouisfed.org](https://research.stlouisfed.org/docs/api/api_key.html). | — |
| `FRED_BASE_URL` | Override the FRED API base URL. | `https://api.stlouisfed.org/fred` |
| `FRED_DATASET_TTL_SECONDS` | TTL for DataCanvas observation tables, in seconds. | `86400` |
| `FRED_DATAFRAME_DROP_ENABLED` | Set `true` to enable `fedreserve_dataframe_drop`; otherwise registered as disabled. | `false` |
| `FRED_CLAMP_LIMITS` | Accept up to 100 series IDs, process 10 observation IDs or 50 metadata IDs, and return `deferred_ids`. Set `false` to reject inputs above those processing limits. | `true` |
| `CANVAS_PROVIDER_TYPE` | DataCanvas engine for SQL over observation results. Set `none` to disable it. | `duckdb` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_JWT_EXPECTED_AUDIENCE` | Required `aud` claim in JWT mode. An unset value accepts any audience and logs a startup warning. | — |
| `MCP_JWT_EXPECTED_ISSUER` | Required `iss` claim in JWT mode. Configure it alongside the audience. | — |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). Set an absolute path to put logs outside the server package. | `<server-package>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP URL for traces (`/v1/traces`) and metrics (`/v1/metrics`). | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | OTLP log endpoint (logs are off unless set). | — |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed tool arguments and results with key-name redaction; secrets in free-form values are not redacted. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Byte cap per logged payload. | `16384` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

SQL over observation tables is on by default; set `CANVAS_PROVIDER_TYPE=none` to turn it off. npm installs and Docker images include the DuckDB runtime. The Claude Desktop bundle omits native bindings and runs with the canvas off; use the npm or Docker installation for SQL over observations.

## Running the server

### Prerequisites

- [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).
- A free FRED API key from [stlouisfed.org](https://fredaccount.stlouisfed.org/login/secure/). The key grants 120 requests/minute.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/federal-reserve-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd federal-reserve-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set FRED_API_KEY
```

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -e FRED_API_KEY=your-api-key -p 3010:3010 ghcr.io/cyanheads/federal-reserve-mcp-server:latest
```

The image defaults to Streamable HTTP at `http://localhost:3010/mcp`. For stdio, run it with `-i -e MCP_TRANSPORT_TYPE=stdio` and omit the port mapping.

```sh
docker build -t federal-reserve-mcp-server .
docker run --rm -e FRED_API_KEY=your-key -e MCP_TRANSPORT_TYPE=http -p 3010:3010 federal-reserve-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/federal-reserve-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Eight tools across FRED domain and DataCanvas. |
| `src/services/fred` | FRED API service — HTTP client, retry, 429 handling, key injection. |
| `src/services/canvas-bridge` | DataCanvas adapter — table naming, TTL/provenance tracking, SQL gate extras. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `docs/` | Design and planning documents. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Import new tools directly into `src/index.ts`; construct configuration-dependent tools in `setup()` before registration
- Wrap FRED API calls: validate raw response → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

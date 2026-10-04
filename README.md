<div align="center">
  <h1>@cyanheads/federal-reserve-mcp-server</h1>
  <p><b>Search and fetch ~800K Federal Reserve economic time-series from the FRED API via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/federal-reserve-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/federal-reserve-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/federal-reserve-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/federal-reserve-mcp-server/releases/latest/download/federal-reserve-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=federal-reserve-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmVkZXJhbC1yZXNlcnZlLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22federal-reserve-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffederal-reserve-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Federal Reserve economic data from the FRED API (Federal Reserve Bank of St. Louis) — ~800K time series covering output, prices, employment, money, rates, housing, trade, and international macro. Search series, fetch metadata and observations, browse the category tree, look up releases, and query large result sets with SQL over DataCanvas. Runs as a stdio process or a local Streamable HTTP server.

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

### `fedreserve_search_series` <sub>tool</sub>

- Full-text or series-ID search, with `frequency`, `units`, `seasonal_adjustment`, and `tag_names` filters
- Pagination via `limit` (default and max 1000) and `offset` (max 4999; FRED caps searchable results at 5000)
- Output includes `active_filters` when applied and `popularity` (0–100) when FRED provides it; empty results suggest a broader query or category browsing

---

### `fedreserve_get_series` <sub>tool</sub>

- Accepts a single series ID or up to 50 in one call; fires parallel upstream requests (no FRED batch endpoint exists)
- Returns title, units, frequency, seasonal adjustment, observation range, popularity, and notes per series
- Partial-batch failures land in a `failed` array with per-ID error messages; a single unresolved ID throws `series_not_found` instead

---

### `fedreserve_get_observations` <sub>tool</sub>

- Accepts one series ID or up to 10, with `observation_start` / `observation_end`, native unit transforms, and frequency downsampling via `aggregation_method` (`avg`, `sum`, `eop`)
- Returns date/value observations with string values that preserve trailing zeros, plus per-series failures
- Multi-series or >500-row results spill to DataCanvas, returning `dataset.name` for `fedreserve_dataframe_query`; without canvas, returns a truncated inline preview

---

### `fedreserve_browse_categories` <sub>tool</sub>

- Omit `category_id` to start at the root (ID 0); returns the category, its child categories, and — for a leaf with no children — a sample of up to 10 series
- An unknown `category_id` throws `category_not_found`

---

### `fedreserve_get_release` <sub>tool</sub>

- Exactly one of `release_id` (integer) or `release_search` (case-insensitive substring, filtered client-side — FRED has no server-side release search) is required
- Returns release name, link, notes, upcoming scheduled dates, and a paginated series list (`series_limit` max 1000, `series_offset`)
- An ambiguous name search returns up to 10 `search_alternatives` instead of guessing; retry with the exact `release_id`

---

### `fedreserve_dataframe_describe` <sub>tool</sub>

- Lists active DataCanvas dataframes for the tenant, or one by `name`, newest first
- Each entry carries `source_tool`, `query_params`, `created_at`, `expires_at`, `row_count`, `truncated` / `max_rows`, and `column_schema`

---

### `fedreserve_dataframe_query` <sub>tool</sub>

- Runs a single read-only DuckDB SELECT against `df_<id>` tables, including joins, aggregates, window functions, and CTEs; external files and system catalogs are blocked
- `row_limit` caps returned rows (default 1000, max 10000); `preview` sets the inline sample. BIGINT results serialize as strings
- Optional `register_as` persists the result as a new dataframe with its own TTL for further queries

---

### `fedreserve_dataframe_drop` <sub>tool</sub>

- Opt-in — enabled when `FRED_DATAFRAME_DROP_ENABLED=true`; otherwise registered as a disabled tool card (visibility depends on the client's protocol version)
- Drops the named dataframe early; returns `dropped: false` when absent. TTL also reclaims expired tables

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

FRED-specific:

- Dataframe tools require `CANVAS_PROVIDER_TYPE=duckdb` and report `canvas_unavailable` otherwise
- `FRED_API_KEY`-gated access to the St. Louis Fed's FRED API (`api.stlouisfed.org/fred`) at up to 120 requests/minute
- Parallel multi-series fetching via `Promise.allSettled`, with partial success reported per ID rather than failing the whole batch
- DataCanvas spillover for multi-series or >500-row observation results, queryable via `fedreserve_dataframe_query`
- FRED's native unit transformations and frequency downsampling delegated server-side for precision against the full series history
- Category tree navigation across all FRED domains — Money & Banking, National Accounts, Employment, Prices, Housing, Trade, and more

Agent-friendly output:

- Graceful partial failure — `fedreserve_get_series` and `fedreserve_get_observations` return per-ID `failed` rows with error messages instead of failing the whole request
- Ambiguous-input disambiguation — `fedreserve_get_release`'s name search returns typed `search_alternatives` instead of guessing when multiple releases match
- Provenance on DataCanvas output — every dataframe carries `source_tool`, `query_params`, and TTL fields so agents can reason about where staged data came from and how long it's valid
- Degrades gracefully — `fedreserve_get_observations` falls back to a truncated inline preview with an explanatory `message` when DataCanvas isn't configured, rather than failing

## Getting started

Add the following to your MCP client configuration file. Obtain a free FRED API key at [research.stlouisfed.org/docs/api/api_key.html](https://research.stlouisfed.org/docs/api/api_key.html).

```json
{
  "mcpServers": {
    "federal-reserve-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/federal-reserve-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "FRED_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "federal-reserve-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/federal-reserve-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "FRED_API_KEY": "your-api-key"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "federal-reserve-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "FRED_API_KEY=your-api-key",
        "ghcr.io/cyanheads/federal-reserve-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 FRED_API_KEY=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
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

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`.

| Variable | Description | Default |
|:---------|:------------|:--------|
| `FRED_API_KEY` | **Required.** API key from [stlouisfed.org](https://research.stlouisfed.org/docs/api/api_key.html). | — |
| `FRED_BASE_URL` | Override the FRED API base URL. | `https://api.stlouisfed.org/fred` |
| `FRED_DATASET_TTL_SECONDS` | Sliding TTL for DataCanvas-registered observation tables (seconds). | `86400` |
| `FRED_DATAFRAME_DROP_ENABLED` | Set `true` to enable `fedreserve_dataframe_drop`; otherwise registered as disabled. | `false` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas SQL querying for observation results. | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session posture: `auto`, `stateful`, or `stateless`. Declared as `stateless` in `src/index.ts` — no tool holds per-session state. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP URL for traces (`/v1/traces`) and metrics (`/v1/metrics`). | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Opt-in OTLP log endpoint, used as-is; the base endpoint does not enable logs. | — |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed tool arguments and results with key-name redaction; secrets in free-form values are not redacted. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Per-payload UTF-8 byte cap for failed-call logging. | `16384` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

Set `CANVAS_PROVIDER_TYPE=duckdb` to enable SQL over observation tables. npm installs and Docker images include the DuckDB runtime. Portable Claude Desktop bundles omit native bindings; use the npm or Docker installation for canvas mode.

## Running the server

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
- Register new tools in `src/mcp-server/tools/definitions/index.ts`
- Wrap FRED API calls: validate raw response → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

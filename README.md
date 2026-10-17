<div align="center">
  <h1>@cyanheads/federal-reserve-mcp-server</h1>
  <p><b>Search and fetch ~800K Federal Reserve economic time-series from the FRED API via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/federal-reserve-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/federal-reserve-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/federal-reserve-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

### `fedreserve_search_series` <sub>tool</sub>

- Full-text or series-ID search, with `frequency`, `units`, `seasonal_adjustment`, and `tag_names` filters; `filter_variable` and `filter_value` must be supplied together or the call returns `invalid_filter`
- Pagination via `limit` (default and max 1000) and `offset` (max 4999; FRED caps searchable results at 5000)
- Output includes `active_filters` and `popularity` (0–100) when available; empty results suggest a broader query or category browsing

---

### `fedreserve_get_series` <sub>tool</sub>

- Accepts one series ID or up to 50 per call
- Returns title, units, frequency, seasonal adjustment, observation range, popularity, and notes per series
- Failed IDs in a batch land in a `failed` array with error messages; a single unresolved ID throws `series_not_found`

---

### `fedreserve_get_observations` <sub>tool</sub>

- Accepts one series ID or up to 10, with `observation_start` / `observation_end` (`YYYY-MM-DD`), native unit transforms, and frequency downsampling via `aggregation_method` (`avg`, `sum`, `eop`)
- Returns date/value observations (values are strings that keep trailing zeros) plus per-series failures
- Multi-series or >500-row results go to a DataCanvas table with a 20-row preview; the `notice` names `dataset.name` and the `fedreserve_dataframe_describe` and `fedreserve_dataframe_query` calls to run next. Without canvas, you get a truncated inline preview

---

### `fedreserve_browse_categories` <sub>tool</sub>

- Omit `category_id` to start at the root (ID 0); returns the category and its children, or up to 10 sample series for a leaf
- An unknown `category_id` throws `category_not_found`

---

### `fedreserve_get_release` <sub>tool</sub>

- Takes exactly one of `release_id` or `release_search` (case-insensitive name substring)
- Returns release name, link, notes, the next five scheduled dates, and a paginated series list (`series_limit` max 1000, `series_offset`)
- An ambiguous name returns up to 10 `search_alternatives`; retry with the exact `release_id`

---

### `fedreserve_dataframe_describe` <sub>tool</sub>

- Lists active DataCanvas dataframes, newest first, or one by `name`
- Each entry carries `source_tool`, `query_params`, `created_at`, `expires_at`, `row_count`, `truncated` / `max_rows`, and `column_schema`

---

### `fedreserve_dataframe_query` <sub>tool</sub>

- Runs one read-only DuckDB SELECT against `df_<id>` tables (joins, aggregates, window functions, CTEs); external files, system catalogs, and engine-setting functions are blocked
- `row_limit` caps returned rows (default 1000, max 10000) and `preview` sets the inline sample; BIGINT results serialize as strings
- `register_as` saves the result as a new dataframe with its own TTL

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
- Dataframe tools require `CANVAS_PROVIDER_TYPE=duckdb` and report `canvas_unavailable` otherwise

Agent-friendly output:

- Partial failures: `fedreserve_get_series` and `fedreserve_get_observations` return per-ID `failed` rows instead of failing the whole request
- Ambiguous release names return `search_alternatives` instead of a guess
- Every dataframe carries `source_tool`, `query_params`, and TTL fields
- Without DataCanvas, `fedreserve_get_observations` returns a truncated inline preview with an explanatory `message`

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
| `FRED_DATASET_TTL_SECONDS` | TTL for DataCanvas observation tables, in seconds. | `86400` |
| `FRED_DATAFRAME_DROP_ENABLED` | Set `true` to enable `fedreserve_dataframe_drop`; otherwise registered as disabled. | `false` |
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas SQL querying for observation results. | — |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base OTLP URL for traces (`/v1/traces`) and metrics (`/v1/metrics`). | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | OTLP log endpoint (logs are off unless set). | — |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed tool arguments and results with key-name redaction; secrets in free-form values are not redacted. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Byte cap per logged payload. | `16384` |

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

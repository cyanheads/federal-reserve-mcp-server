<div align="center">
  <h1>@cyanheads/fred-mcp-server</h1>
  <p><b>Search and fetch ~800K Federal Reserve economic time-series from the FRED API via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![npm](https://img.shields.io/npm/v/@cyanheads/fred-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/fred-mcp-server) [![Version](https://img.shields.io/badge/Version-0.1.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/fred-mcp-server/releases/latest/download/fred-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=fred-mcp-server&config=eyJjb21tYW5kIjoibnB4IC15IEBjeWFuaGVhZHMvZnJlZC1tY3Atc2VydmVyIn0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22fred-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffred-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Five FRED tools plus three DataCanvas tools for querying spilled observation results via SQL:

| Tool | Description |
|:-----|:------------|
| `fred_search_series` | Full-text search across FRED series titles, units, frequency, and tags — returns matching series IDs with metadata |
| `fred_get_series` | Fetch metadata for one or more series (title, units, frequency, seasonal adjustment, observation range) |
| `fred_get_observations` | Fetch date+value observation data for one or more series with date-range filtering and unit transformations |
| `fred_browse_categories` | Navigate the FRED category tree; drill into a category to see child categories and a series sample |
| `fred_get_release` | Look up a FRED release by ID or name search — returns release metadata and its associated series list |
| `fred_dataframe_describe` | List active DataCanvas dataframes registered by this server (canvas IDs, row counts, schemas) |
| `fred_dataframe_query` | Run a SELECT query against a registered DataCanvas dataframe |
| `fred_dataframe_drop` | Drop a DataCanvas dataframe by canvas ID (configurable via `FRED_DATAFRAME_DROP` env var) |

### `fred_search_series`

Search for FRED series by free-text query across titles, tags, and notes.

- Full-text and series-ID search modes
- Post-search filtering by frequency, units, or seasonal adjustment status
- Tag-name filtering (semicolon-delimited list)
- Pagination via `limit` and `offset`
- To find series for a specific release, use `fred_get_release` instead

---

### `fred_get_series`

Fetch metadata for one or more FRED series.

- Accepts up to 50 series IDs in a single call
- Returns title, units, frequency, seasonal adjustment, observation range, popularity, and notes
- Fires parallel upstream requests (no FRED batch endpoint exists); partial success reported per ID

---

### `fred_get_observations`

Fetch observation data (date + value pairs) for one or more series.

- Accepts up to 10 series IDs; fires one upstream request per series in parallel
- Date-range filtering with ISO 8601 dates (`observation_start`, `observation_end`)
- FRED's native unit transformations: `lin`, `chg`, `ch1`, `pch`, `pc1`, `pca`, `cch`, `cca`, `log`
- Frequency downsampling with configurable aggregation method (`avg`, `sum`, `eop`)
- Multi-series or >500-row results spill to a DataCanvas table for SQL querying via `canvas_id`
- Degrades gracefully when DataCanvas is unavailable — returns inline preview with row count

---

### `fred_browse_categories`

Navigate the FRED category hierarchy.

- Omit `category_id` to start at the root (ID 0)
- Provide a `category_id` to see child categories and a series sample for leaf categories
- Covers all FRED domains: Money & Banking, National Accounts, Employment, Prices, Housing, Trade, and more

---

### `fred_get_release`

Inspect a FRED data release and its associated series.

- Look up by `release_id` (integer) or `release_search` (case-insensitive substring match)
- Name search fetches all releases and filters client-side (FRED has no server-side release search)
- Returns release name, link, scheduled dates, and a paginated series list
- Use `series_limit` and `series_offset` to page through large releases

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

FRED-specific:

- Read-only access to the St. Louis Fed's FRED API (`api.stlouisfed.org/fred`)
- Parallel multi-series fetching via `Promise.allSettled` with partial success reporting
- DataCanvas spillover for multi-series or large observation results (opt-in via `canvas_id`)
- Retry with backoff and 429 rate-limit detection against FRED's 120 req/min limit
- FRED's native unit transformations delegated server-side for precision against the full series history

## Getting started

Add the following to your MCP client configuration file. Obtain a free FRED API key at [research.stlouisfed.org/docs/api/api_key.html](https://research.stlouisfed.org/docs/api/api_key.html).

```json
{
  "mcpServers": {
    "fred": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/fred-mcp-server@latest"],
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
    "fred": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/fred-mcp-server@latest"],
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
    "fred": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "FRED_API_KEY=your-api-key",
        "ghcr.io/cyanheads/fred-mcp-server:latest"
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

- [Bun v1.3.2](https://bun.sh/) or higher.
- A free FRED API key from [stlouisfed.org](https://fredaccount.stlouisfed.org/login/secure/). The key grants 120 requests/minute.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/fred-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd fred-mcp-server
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

| Variable | Description | Default |
|:---------|:------------|:--------|
| `FRED_API_KEY` | **Required.** API key from stlouisfed.org. | — |
| `FRED_BASE_URL` | Override the FRED API base URL. | `https://api.stlouisfed.org/fred` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

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

```json
{
  "mcpServers": {
    "fred": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "-e", "FRED_API_KEY=your-api-key", "ghcr.io/cyanheads/fred-mcp-server:latest"]
    }
  }
}
```

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/services/fred` | FRED API service — HTTP client, retry, 429 handling, key injection. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `docs/` | Design and planning documents. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools in `src/mcp-server/tools/definitions/index.ts`
- Wrap FRED API calls: validate raw response → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

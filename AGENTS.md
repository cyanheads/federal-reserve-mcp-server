# Agent Protocol

**Server:** @cyanheads/fred-mcp-server
**Version:** 0.1.4
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.9.6`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what to do next, what's left, or needs direction, suggest relevant options based on the current project state:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Domain

This server wraps the [FRED API](https://fred.stlouisfed.org/docs/api/fred/) (Federal Reserve Bank of St. Louis). ~800K economic time-series covering output, prices, employment, money, rates, housing, trade, regional indicators, and international macro.

**Tool surface:**

| Tool | Description |
|:-----|:------------|
| `fred_search_series` | Full-text search across FRED series titles, units, frequency, and tags |
| `fred_get_series` | Fetch metadata for one or more series (up to 50 IDs, parallel upstream requests) |
| `fred_get_observations` | Fetch date+value observations with date-range, unit transforms, and DataCanvas spillover |
| `fred_browse_categories` | Navigate the FRED category tree |
| `fred_get_release` | Inspect a release by ID or name search |
| `fred_dataframe_describe` | List active DataCanvas dataframes with provenance, schema, and row count |
| `fred_dataframe_query` | Run a SELECT against registered DataCanvas dataframes via DuckDB SQL |
| `fred_dataframe_drop` | Drop a DataCanvas dataframe by name (opt-in via `FRED_DATAFRAME_DROP_ENABLED=true`) |

**Key API facts:**
- Auth: `FRED_API_KEY` env var (free key from stlouisfed.org)
- Rate limit: 120 req/min per key
- No batch endpoints — parallel requests via `Promise.allSettled`
- Observations are date+value pairs; values are strings (preserves trailing zeros)
- ALFRED vintages deferred to v1+

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getFredApiService } from '@/services/fred/fred-service.js';

export const fredSearchSeriesToolDef = tool('fred_search_series', {
  description: 'Search FRED series by full-text query across titles, tags, and notes.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z.string().describe('Search terms'),
    search_type: z.enum(['full_text', 'series_id']).optional()
      .describe('Search mode — full_text (default) or series_id'),
    filter_variable: z.enum(['frequency', 'units', 'seasonal_adjustment']).optional()
      .describe('Post-search filter dimension'),
    filter_value: z.string().optional().describe('Value for filter_variable'),
    tag_names: z.string().optional().describe('Semicolon-delimited list of tag names to filter by'),
    limit: z.number().int().min(1).max(1000).optional().describe('Max results (default 1000)'),
    offset: z.number().int().min(0).optional().describe('Pagination offset'),
  }),

  output: z.object({
    count: z.number().describe('Total matching series count'),
    series: z.array(z.object({
      id: z.string().describe('FRED series ID (e.g., UNRATE)'),
      title: z.string().describe('Series title'),
      units: z.string().describe('Units of measurement'),
      frequency: z.string().describe('Data frequency'),
      last_updated: z.string().describe('ISO 8601 date of last update'),
    })).describe('Matching series'),
  }),

  async handler(input, ctx) {
    ctx.log.info('Executing fred_search_series', { query: input.query });
    const result = await getFredApiService().searchSeries(input);
    return result;
  },

  format: (result) => [{
    type: 'text',
    text: result.series.map(s =>
      `**${s.id}**: ${s.title} (${s.units}, ${s.frequency}, updated ${s.last_updated})`
    ).join('\n'),
  }],
});
```

### Server config

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z.string().describe('FRED API key from stlouisfed.org.'),
  baseUrl: z.string().url().default('https://api.stlouisfed.org/fred').describe('FRED API base URL.'),
  datasetTtlSeconds: z.coerce.number().int().positive().default(86400)
    .describe('Sliding TTL for canvas-registered dataframes (seconds).'),
  dataframeDrop: z.coerce.boolean().default(false)
    .describe('Set to true to expose fred_dataframe_drop.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'FRED_API_KEY',
    baseUrl: 'FRED_BASE_URL',
    datasetTtlSeconds: 'FRED_DATASET_TTL_SECONDS',
    dataframeDrop: 'FRED_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`FRED_API_KEY`) not the path (`apiKey`). Throws `ConfigurationError`, which the framework prints as a clean startup banner.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT, `'default'` for stdio or HTTP+`MCP_AUTH_MODE=none`. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, and the linter enforces conformance. The `recovery` field is required (≥ 5 words, lint-validated). Spread `ctx.recoveryFor('reason')` into `data` to mirror the contract hint onto the wire. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
errors: [
  { reason: 'series_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'Series ID exists in format but FRED returns no data',
    recovery: 'Verify the series ID with fred_search_series and try again.' },
],
async handler(input, ctx) {
  const series = await getFredApiService().getSeries(input.series_id);
  if (!series) {
    throw ctx.fail('series_not_found', `Series ${input.series_id} not found`, {
      ...ctx.recoveryFor('series_not_found'),
    });
  }
  return series;
}
```

**Fallback (no contract entry fits):** error factories or plain `Error`.

```ts
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Series not found', { seriesId });
throw serviceUnavailable('FRED API unavailable', { url }, { cause: err });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point
  config/
    server-config.ts                    # FRED-specific env vars (Zod schema)
  services/
    fred/
      fred-service.ts                   # FredApiService (init/accessor pattern)
      types.ts                          # FRED domain types
    canvas-bridge/
      canvas-bridge.ts                  # DataCanvas adapter (table naming, TTL, provenance)
      sql-gate-extras.ts                # Extra SQL gate rules for DuckDB system catalogs
  mcp-server/
    tools/definitions/
      fred-search-series.tool.ts        # fred_search_series
      fred-get-series.tool.ts           # fred_get_series
      fred-get-observations.tool.ts     # fred_get_observations
      fred-browse-categories.tool.ts    # fred_browse_categories
      fred-get-release.tool.ts          # fred_get_release
      fred-dataframe-describe.tool.ts   # fred_dataframe_describe
      fred-dataframe-query.tool.ts      # fred_dataframe_query
      fred-dataframe-drop.tool.ts       # fred_dataframe_drop (opt-in)
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `fred-get-series.tool.ts` |
| Tool/resource/prompt names | snake_case | `fred_get_series` |
| Directories | kebab-case | `src/services/fred/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Fetch metadata for one or more FRED series.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-05-21`).

---

## Commands

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting |
| `bun run test` | Run tests |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run list-skills` | List available project skills (useful for sub-agents) |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, re-audit. Use when `devcheck` flags a transitive advisory — stale lockfile can mask already-patched deps. If advisory survives, it's real. |
| `bun run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `bun run lint:packaging` | Verify env var alignment between `manifest.json` and `server.json` |

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true flags security fixes
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section. When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getFredApiService } from '@/services/fred/fred-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] FRED wrapping: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] FRED wrapping: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] FRED wrapping: tests include at least one sparse payload case with omitted upstream fields
- [ ] FRED wrapping: observation values kept as strings (FRED returns them as strings to preserve trailing zeros — don't coerce to float)
- [ ] Multi-series tools use `Promise.allSettled` with partial success reporting
- [ ] `fred_get_observations` DataCanvas spillover: multi-series or >500 rows spill to canvas; single short-range returns inline; degrades gracefully when canvas unavailable
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `bun run devcheck` passes

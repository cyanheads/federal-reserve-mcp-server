# Agent Protocol

**Server:** @cyanheads/federal-reserve-mcp-server
**Version:** 0.2.5
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.11`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.2.0
**Zod:** ^4.6.5

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
| `fedreserve_search_series` | Full-text search across FRED series titles, units, frequency, and tags |
| `fedreserve_get_series` | Fetch metadata for one or more series (up to 50 IDs, parallel upstream requests) |
| `fedreserve_get_observations` | Fetch date+value observations with date-range, unit transforms, and DataCanvas spillover |
| `fedreserve_browse_categories` | Navigate the FRED category tree |
| `fedreserve_get_release` | Inspect a release by ID or name search |
| `fedreserve_dataframe_describe` | List active DataCanvas dataframes with provenance, schema, and row count |
| `fedreserve_dataframe_query` | Run a SELECT against registered DataCanvas dataframes via DuckDB SQL |
| `fedreserve_dataframe_drop` | Drop a DataCanvas dataframe by name (opt-in via `FRED_DATAFRAME_DROP_ENABLED=true`) |

**Key API facts:**
- Auth: `FRED_API_KEY` env var (free key from stlouisfed.org)
- Rate limit: 120 req/min per key
- No batch endpoints — parallel requests via `Promise.allSettled`
- Observations are date+value pairs; values are strings (preserves trailing zeros)
- ALFRED vintages deferred to v1+

**Input aliases.** FRED's own parameter names differ from two tool inputs here, so callers reaching for the upstream spelling are rewritten rather than rejected: `series_id` → `series_ids` on `fedreserve_get_series` and `fedreserve_get_observations`, `search_text` → `query` on `fedreserve_search_series`. Aliases are not advertised — `inputSchema` is identical with or without them. Declare one only where the upstream API or a sibling tool uses that exact spelling; case-style variants (`seriesIds`) are rewritten by the framework with nothing declared.

**`canvas_id` is not a minted canvas ID.** The framework's `CanvasIdSchema` (`^[A-Za-z0-9_-]{10}$`) does not fit `fedreserve_get_observations`'s `canvas_id` input: this server never surfaces a raw canvas ID — `CanvasBridge` keeps it in `ctx.state` — and the only handle a caller gets back is the 13-character `df_XXXXX_XXXXX` table name. Applying the schema would reject the one value the field's own documentation tells callers to pass.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler. (`ctx.elicit` was removed in 0.12.0 — do not reference it.)
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { getFredApiService } from '@/services/fred/fred-service.js';

export const fedreserveSearchSeriesToolDef = tool('fedreserve_search_series', {
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
    ctx.log.info('Executing fedreserve_search_series', { query: input.query });
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
  dataframeDrop: z.stringbool().default(false)
    .describe('Set to true to enable fedreserve_dataframe_drop; otherwise registered as disabled.'),
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

An empty string and a whole-value unsubstituted `${…}` placeholder read as unset on both config paths — an optional field stays `undefined`, a defaulted field takes its default, and a required field fails as missing. Don't add a per-server `z.preprocess` guard for either case.

For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment. `z.stringbool()` parses `true/false/1/0/yes/no/on/off` and rejects anything else, so `=false` actually disables.

### Session posture and shutdown

```ts
await createApp({
  sessionMode: 'stateless',
  setup(core) { initFredApiService(); initCanvasBridge(core.canvas); },
});
```

`sessionMode` declares the HTTP session posture in `src/` instead of leaving it to a deployment's `MCP_SESSION_MODE`, which still wins whenever it carries a meaningful value. This server is `stateless`: no tool calls `ctx.requestInput`, so nothing needs a session store, and `ctx.state` (tenant-scoped storage, where canvas provenance and TTL live) is unaffected by session mode. Add `require: 'stateful'` only if a tool later gates on `ctx.requestInput`.

`teardown(core)` is the `setup()` counterpart — release a watcher, socket, or non-`unref()`'d timer there. Neither `FredApiService` nor `CanvasBridge` allocates one (`fetchWithTimeout` is per-request; the canvas registry is a core service the framework disposes), so this server declares no `teardown`. Add one the moment a service allocates something that outlives a request.

---

## Context

Handlers receive a unified `ctx` object. Key properties:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.getMany(keys)`, `.list(prefix, { cursor, limit })`. Accepts JSON-serializable values; reads return their JSON form (a `Date` becomes an ISO string). |
| `ctx.requestInput` | Suspend and ask the caller for more input — the handler is re-entered with the answers via `ctx.inputs`. Always present. |
| `ctx.inputs` | Client-supplied responses — `.accepted(key, schema)`, `.view(key)`, `.state()`, `.dropped` — limited to the client's declared capabilities. Consent gates redeem a stored `ctx.state` record bound to the operation, caller, and target; see `api-context`. |
| `ctx.clientCapabilities` | What the client declared, or `undefined` when unavailable. Determines whether to ask for optional context, never whether to skip consent. |
| `ctx.enrich` | Success-path agent context (empty-result notices, query echo, pagination totals) — `ctx.enrich(...)` or `.notice()` / `.total()` / `.echo()` / `.truncated()`. Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block (no-op otherwise). |
| `ctx.content` | Non-text content blocks — `.image(data, mimeType)`, `.audio(data, mimeType)`, or `ctx.content(block)` for a raw block. Prepended to `content[]` after `format()`; never enters `structuredContent`. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Request ID shared by the call's log records and error envelope (`data.requestId`). |
| `ctx.tenantId` | Tenant ID from JWT; `'default'` for stdio or HTTP with auth off. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos, `data.reason` is populated for observability, and the linter enforces conformance. The required `recovery` (≥ 5 words) reaches `data.recovery.hint` and `content[]` automatically when an error carrying that reason has no explicit hint, including service throws. Override with `{ recovery: { hint } }` only for dynamic guidance. Error envelopes also carry `data.requestId`. Mark a service-thrown entry `thrownBy: 'service'` to skip handler-only lint; `severity` (`debug` / `info` / `notice` / `warning`) moves its log record below `error`. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
errors: [
  { reason: 'series_not_found', code: JsonRpcErrorCode.NotFound,
    when: 'Series ID exists in format but FRED returns no data',
    recovery: 'Verify the series ID with fedreserve_search_series and try again.' },
],
async handler(input, ctx) {
  const series = await getFredApiService().getSeries(input.series_id);
  if (!series) {
    throw ctx.fail('series_not_found', `Series ${input.series_id} not found`);
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

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

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
  mcp-server/
    tools/definitions/
      fedreserve-search-series.tool.ts        # fedreserve_search_series
      fedreserve-get-series.tool.ts           # fedreserve_get_series
      fedreserve-get-observations.tool.ts     # fedreserve_get_observations
      fedreserve-browse-categories.tool.ts    # fedreserve_browse_categories
      fedreserve-get-release.tool.ts          # fedreserve_get_release
      fedreserve-dataframe-describe.tool.ts   # fedreserve_dataframe_describe
      fedreserve-dataframe-query.tool.ts      # fedreserve_dataframe_query
      fedreserve-dataframe-drop.tool.ts       # fedreserve_dataframe_drop (opt-in)
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `fedreserve-get-series.tool.ts` |
| Tool/resource/prompt names | snake_case | `fedreserve_get_series` |
| Directories | kebab-case | `src/services/fred/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Fetch metadata for one or more FRED series.'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

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
| `tool-defs-analysis` | Read-only audit of MCP definition language — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync |
| `release-and-publish` | Fast-forward merge + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when sub-agents are available |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |
| `techniques` | Reusable response/data-shaping patterns (outline-on-overflow, etc.) |

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
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff |
| `bun run test` | Run tests |
| `bun run lint:mcp` | Validate MCP definitions against spec |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run list-skills` | List available project skills (useful for sub-agents) |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run lint:packaging` | Verify env var alignment between `manifest.json` and `server.json`, and the plugin manifests' display/install/version fields |

**CI is one file.** `.github/workflows/codeql.yml` is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**The plugin manifests are a third and fourth surface:** `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` + `.codex-plugin/mcp.json`. Display fields take the unscoped repo name `federal-reserve-mcp-server`; the `npx` install arg takes the scoped npm name `@cyanheads/federal-reserve-mcp-server`; each `version` must equal `package.json`'s. `FRED_API_KEY` reaches the server through `userConfig` + `"${user_config.fred_api_key}"` in the Claude manifest and through `env_vars` in the Codex one — never as `"FRED_API_KEY": ""`, which replaces the user's exported key with a value read as unset.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

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
- [ ] `fedreserve_get_observations` DataCanvas spillover: multi-series or >500 rows spill to canvas; single short-range returns inline; degrades gracefully when canvas unavailable
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env`
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `bun run devcheck` passes

# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-08-21

Adopts @cyanheads/mcp-ts-core ^0.12.3 — MCP SDK v2 protocol era, whole-exchange fetch timeouts, tightened definition linter — with enrichment totals on three tools, TypeScript 7, and Bun 1.4 Docker images.

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-06-20

Server-level instructions advertised in the MCP initialize response; maintenance adopt @cyanheads/mcp-ts-core 0.10.9.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-12

Maintenance: adopt @cyanheads/mcp-ts-core 0.10.6 — framework system-catalog SQL gate, stringbool config coercion, explicit createApp identity.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-05-24 · ⚠️ Breaking

Rename: repo, npm package, and all tool names changed from fred_* to fedreserve_* (breaking for tool-name references).

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-23

Field-test bug fixes: error classification, input validation, and output formatting across FRED tools.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-23

Pre-launch polish: code simplification in fred-get-observations and fred-get-release, AGENTS.md added, Dockerfile OCI labels and .env.example filled in, bunfig.toml added.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-23 · 🛡️ Security

Field-test fixes: API key stripped from error URLs, single-ID not-found, observation_count accuracy, search UX, description cleanup.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-23

Error code semantics, mcp-ts-core ^0.9.5 → ^0.9.6, LICENSE added.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-23

Maintenance: mcp-ts-core ^0.9.5, explicit zod dep, MCPB bundle support, async cleanup.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-21

Full FRED tool surface implementation: five domain tools, DataCanvas integration, FredApiService, and test coverage.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-21

Initial scaffold from @cyanheads/mcp-ts-core; tool-surface design for FRED API wrapper.

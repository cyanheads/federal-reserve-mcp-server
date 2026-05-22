# fred-mcp-server — Idea

Pre-design seed. Feeds into `design-mcp-server` to produce `docs/design.md`.

## Domain

Federal Reserve Economic Data (FRED) — the St. Louis Fed's time-series database. ~800K economic series covering output, prices, employment, money, rates, housing, trade, regional indicators, and international macro. Canonical source for US macroeconomic data and the friendliest API for anything the Fed touches.

## Data source

- **API:** https://fred.stlouisfed.org/docs/api/fred/
- **Auth:** free API key (register at stlouisfed.org)
- **Rate limit:** 120 requests/minute per key
- **Format:** JSON; observations are date+value pairs
- **Vintages:** ALFRED exposes historical vintages of revised series — defer past v1

## User goals

- Resolve a topic ("unemployment", "core inflation", "10-year yield") to the right series ID
- Pull observations for one or more series over a date range
- Compare multiple series on the same time axis (CPI vs core CPI, two yield curves)
- Discover what's in a release (latest Employment Situation, FOMC dot plot)
- Browse categories and tags to find related series

## Tool sketch

| Tool | Purpose |
|:-----|:--------|
| `fred_search_series` | Free-text search across titles, tags, notes → SeriesIDs |
| `fred_get_observations` | Pull observations for one or more series with date range, frequency, unit transformations (pct change, YoY, log) |
| `fred_get_series` | Metadata for a series (title, units, frequency, last updated, notes) |
| `fred_browse_categories` | Walk the category tree (Money, Banking & Finance → Interest Rates → Treasury) |
| `fred_get_release` | Inspect a release (e.g., Employment Situation) and its associated series |

## Pairs with

- **secedgar-mcp-server** — macro context for filings (rate environment, sector indices)
- **bls-mcp-server** — BLS publishes many series FRED republishes; FRED is the easier API but BLS has freshness edge for some
- **eia-mcp-server** — energy series cross-referenced

## Open questions

- Surface ALFRED vintages or skip in v1? (probably skip)
- Tabular spillover for multi-series + long date ranges — DataCanvas almost certainly yes
- Unit transformations: handle server-side via FRED's `units` param, or pass-through and let the agent compute?
- Curated "common asks" lookup (e.g., "unemployment rate" → `UNRATE`) baked in, or rely on search?

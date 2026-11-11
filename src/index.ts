#!/usr/bin/env node
/**
 * @fileoverview federal-reserve-mcp-server MCP server entry point. Registers all FRED
 * tools and wires the FredApiService and CanvasBridgeService during setup.
 * @module index
 */

import { existsSync } from 'node:fs';
import { createApp } from '@cyanheads/mcp-ts-core';
import { normalizeEnv } from '@cyanheads/mcp-ts-core/config';
import type { AnyToolDefinition } from '@cyanheads/mcp-ts-core/tools';
import { getServerConfig } from './config/server-config.js';
import { fedreserveBrowseCategoriesTool } from './mcp-server/tools/definitions/fedreserve-browse-categories.tool.js';
import { fedreserveDataframeDescribeTool } from './mcp-server/tools/definitions/fedreserve-dataframe-describe.tool.js';
import { buildFedreserveDataframeDropTool } from './mcp-server/tools/definitions/fedreserve-dataframe-drop.tool.js';
import { fedreserveDataframeQueryTool } from './mcp-server/tools/definitions/fedreserve-dataframe-query.tool.js';
import { buildFedreserveGetObservationsTool } from './mcp-server/tools/definitions/fedreserve-get-observations.tool.js';
import { fedreserveGetReleaseTool } from './mcp-server/tools/definitions/fedreserve-get-release.tool.js';
import { buildFedreserveGetSeriesTool } from './mcp-server/tools/definitions/fedreserve-get-series.tool.js';
import { fedreserveSearchSeriesTool } from './mcp-server/tools/definitions/fedreserve-search-series.tool.js';
import { initCanvasBridge } from './services/canvas-bridge/canvas-bridge.js';
import { initFredApiService } from './services/fred/fred-service.js';

// Read Node's .env before seeding the default. createApp validates the result.
if (existsSync('.env')) process.loadEnvFile();
if (normalizeEnv(process.env).CANVAS_PROVIDER_TYPE === undefined) {
  process.env.CANVAS_PROVIDER_TYPE = 'duckdb';
}

const tools: AnyToolDefinition[] = [
  fedreserveSearchSeriesTool,
  fedreserveBrowseCategoriesTool,
  fedreserveGetReleaseTool,
  fedreserveDataframeDescribeTool,
  fedreserveDataframeQueryTool,
];

await createApp({
  name: 'federal-reserve-mcp-server',
  title: 'federal-reserve-mcp-server',
  /**
   * No tool here calls `ctx.requestInput`, so nothing needs the session store.
   * `MCP_SESSION_MODE` still wins when a deployment sets it; this declaration is
   * what a source run and the container resolve to otherwise. Canvas provenance
   * and TTL live in `ctx.state` (tenant-scoped storage), which session mode does
   * not touch.
   */
  sessionMode: 'stateless',
  instructions:
    "Use the fedreserve_* tools to query FRED economic time series (Federal Reserve Bank of St. Louis); a free FRED_API_KEY is required. Discover series IDs via fedreserve_search_series, fedreserve_browse_categories, or fedreserve_get_release, then pull date+value data with fedreserve_get_observations (metadata via fedreserve_get_series). Series are keyed by FRED ID like UNRATE; observation values stay strings — preserve trailing zeros, don't coerce. Multi-series or large pulls spill to a DataCanvas table queried with fedreserve_dataframe_query.",
  tools,
  skills: 'skills',
  resources: [],
  prompts: [],
  setup(core) {
    const { dataframeDrop, clampLimits } = getServerConfig();
    initFredApiService();
    initCanvasBridge(core.canvas);
    // setup runs before the framework builds the tool registry.
    tools.push(
      buildFedreserveGetSeriesTool(clampLimits),
      buildFedreserveGetObservationsTool(clampLimits),
      buildFedreserveDataframeDropTool(dataframeDrop),
    );
  },
});

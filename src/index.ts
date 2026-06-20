#!/usr/bin/env node
/**
 * @fileoverview federal-reserve-mcp-server MCP server entry point. Registers all FRED
 * tools and wires the FredApiService and CanvasBridgeService during setup.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import {
  buildFedreserveDataframeDropTool,
  fedreserveBrowseCategoriesTool,
  fedreserveDataframeDescribeTool,
  fedreserveDataframeQueryTool,
  fedreserveGetObservationsTool,
  fedreserveGetReleaseTool,
  fedreserveGetSeriesTool,
  fedreserveSearchSeriesTool,
} from './mcp-server/tools/definitions/index.js';
import { initCanvasBridge } from './services/canvas-bridge/canvas-bridge.js';
import { initFredApiService } from './services/fred/fred-service.js';

const { dataframeDrop } = getServerConfig();

await createApp({
  name: 'federal-reserve-mcp-server',
  title: 'federal-reserve-mcp-server',
  instructions:
    "Use the fedreserve_* tools to query FRED economic time series (Federal Reserve Bank of St. Louis); a free FRED_API_KEY is required. Discover series IDs via fedreserve_search_series, fedreserve_browse_categories, or fedreserve_get_release, then pull date+value data with fedreserve_get_observations (metadata via fedreserve_get_series). Series are keyed by FRED ID like UNRATE; observation values stay strings — preserve trailing zeros, don't coerce. Multi-series or large pulls spill to a DataCanvas table queried with fedreserve_dataframe_query.",
  tools: [
    fedreserveSearchSeriesTool,
    fedreserveGetSeriesTool,
    fedreserveGetObservationsTool,
    fedreserveBrowseCategoriesTool,
    fedreserveGetReleaseTool,
    fedreserveDataframeDescribeTool,
    fedreserveDataframeQueryTool,
    buildFedreserveDataframeDropTool(dataframeDrop),
  ],
  resources: [],
  prompts: [],
  setup(core) {
    initFredApiService();
    initCanvasBridge(core.canvas);
  },
});

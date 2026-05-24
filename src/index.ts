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

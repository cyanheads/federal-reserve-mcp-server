#!/usr/bin/env node
/**
 * @fileoverview fred-mcp-server MCP server entry point. Registers all FRED
 * tools and wires the FredApiService and CanvasBridgeService during setup.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import {
  buildFredDataframeDropTool,
  fredBrowseCategoriesTool,
  fredDataframeDescribeTool,
  fredDataframeQueryTool,
  fredGetObservationsTool,
  fredGetReleaseTool,
  fredGetSeriesTool,
  fredSearchSeriesTool,
} from './mcp-server/tools/definitions/index.js';
import { initCanvasBridge } from './services/canvas-bridge/canvas-bridge.js';
import { initFredApiService } from './services/fred/fred-service.js';

const { dataframeDrop } = getServerConfig();

await createApp({
  tools: [
    fredSearchSeriesTool,
    fredGetSeriesTool,
    fredGetObservationsTool,
    fredBrowseCategoriesTool,
    fredGetReleaseTool,
    fredDataframeDescribeTool,
    fredDataframeQueryTool,
    buildFredDataframeDropTool(dataframeDrop),
  ],
  resources: [],
  prompts: [],
  setup(core) {
    initFredApiService();
    initCanvasBridge(core.canvas);
  },
});

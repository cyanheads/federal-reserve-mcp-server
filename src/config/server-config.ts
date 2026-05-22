/**
 * @fileoverview FRED-specific server configuration. Parsed lazily via
 * `parseEnvConfig` so Workers can inject env at request time before this is
 * ever read.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiKey: z.string().describe('FRED API key from stlouisfed.org.'),
  baseUrl: z
    .string()
    .url()
    .default('https://api.stlouisfed.org/fred')
    .describe('FRED API base URL.'),
  datasetTtlSeconds: z.coerce
    .number()
    .int()
    .positive()
    .default(86400)
    .describe('Per-table sliding TTL for canvas-registered dataframes (seconds).'),
  dataframeDrop: z.coerce
    .boolean()
    .default(false)
    .describe('Set to true to expose fred_dataframe_drop.'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiKey: 'FRED_API_KEY',
    baseUrl: 'FRED_BASE_URL',
    datasetTtlSeconds: 'FRED_DATASET_TTL_SECONDS',
    dataframeDrop: 'FRED_DATAFRAME_DROP_ENABLED',
  });
  return _config;
}

/** For test isolation — reset parsed config so getServerConfig() re-parses. */
export function resetServerConfig(): void {
  _config = undefined;
}

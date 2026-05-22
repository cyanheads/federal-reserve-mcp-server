/**
 * @fileoverview Drop a canvas dataframe by name. Opt-in: only registered in
 * createApp() when FRED_DATAFRAME_DROP_ENABLED=true. Idempotent — returns
 * `dropped: false` when nothing matched. TTL handles cleanup in normal
 * operation; this tool is for explicit early reclamation.
 * @module mcp-server/tools/definitions/fred-dataframe-drop
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const fredDataframeDropToolDef = tool('fred_dataframe_drop', {
  title: 'Drop FRED Dataframe',
  description:
    'Drop a canvas dataframe by name. Idempotent — returns dropped: false when nothing matched. TTL handles cleanup in normal operation; this tool is for explicit early reclamation when an analysis session is complete. Requires CANVAS_PROVIDER_TYPE=duckdb and FRED_DATAFRAME_DROP_ENABLED=true.',
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    openWorldHint: false,
    destructiveHint: true,
  },

  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The DataCanvas service is not configured for this deployment.',
      recovery:
        'Set CANVAS_PROVIDER_TYPE=duckdb in the server environment and restart to enable dataframes.',
    },
  ],

  input: z.object({
    name: z.string().min(1).describe('Canvas table name to drop (df_XXXXX_XXXXX format).'),
  }),

  output: z.object({
    dropped: z
      .boolean()
      .describe('True when the dataframe was found and dropped. False when it was not present.'),
    name: z.string().describe('The name that was targeted.'),
  }),

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.', {
        ...ctx.recoveryFor('canvas_unavailable'),
      });
    }

    ctx.log.info('fred_dataframe_drop', { name: input.name });
    const dropped = await bridge.drop(ctx, input.name);
    return { dropped, name: input.name };
  },

  format: (result) => {
    const msg = result.dropped
      ? `Dropped dataframe \`${result.name}\`.`
      : `Dataframe \`${result.name}\` was not found — nothing to drop. Dropped: ${result.dropped}.`;
    return [{ type: 'text', text: msg }];
  },
});

/**
 * When `FRED_DATAFRAME_DROP_ENABLED=true` the tool is active; otherwise it is
 * present in the MCP manifest as a disabled card (visible but uncallable).
 * The enabled check is deferred to index.ts so this module can be imported
 * by the linter without a FRED_API_KEY.
 */
export function buildFredDataframeDropTool(enabled: boolean) {
  return enabled
    ? fredDataframeDropToolDef
    : disabledTool(fredDataframeDropToolDef, {
        reason: 'Dataframe drop is disabled in this deployment.',
        hint: 'FRED_DATAFRAME_DROP_ENABLED=true',
      });
}

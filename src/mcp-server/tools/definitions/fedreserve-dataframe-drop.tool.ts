/**
 * @fileoverview Drop a canvas dataframe by name. Always registered; enabled
 * only when FRED_DATAFRAME_DROP_ENABLED=true. Idempotent — returns
 * `dropped: false` when nothing matched. TTL handles cleanup in normal
 * operation; this tool is for explicit early reclamation.
 * @module mcp-server/tools/definitions/fedreserve-dataframe-drop
 */

import { disabledTool, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const fedreserveDataframeDropToolDef = tool('fedreserve_dataframe_drop', {
  title: 'Drop FRED Dataframe',
  description:
    'Drop a canvas dataframe by name. Idempotent — returns dropped: false when nothing matched. TTL handles cleanup in normal operation; this tool is for explicit early reclamation when an analysis session is complete. Requires FRED_DATAFRAME_DROP_ENABLED=true; unavailable when the server sets CANVAS_PROVIDER_TYPE=none.',
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
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.');
    }

    ctx.log.info('fedreserve_dataframe_drop', { name: input.name });
    const dropped = await bridge.drop(ctx, input.name);
    return { dropped, name: input.name };
  },

  format: (result) => {
    if (result.name.includes('\r') || result.name.includes('\0')) {
      return [{ type: 'text', text: markdown().codeBlock(JSON.stringify(result), 'json').build() }];
    }
    const name = escapeMarkdownInline(result.name);
    const msg = result.dropped
      ? `Dropped dataframe ${name}.`
      : `Dataframe ${name} was not found — nothing to drop. Dropped: ${result.dropped}.`;
    return [{ type: 'text', text: msg }];
  },
});

/**
 * When `FRED_DATAFRAME_DROP_ENABLED=true` the tool is active; otherwise it is
 * present in the MCP manifest as a disabled card (visible but uncallable).
 * The enabled check is deferred to index.ts so this module can be imported
 * by the linter without a FRED_API_KEY.
 */
export function buildFedreserveDataframeDropTool(enabled: boolean) {
  return enabled
    ? fedreserveDataframeDropToolDef
    : disabledTool(fedreserveDataframeDropToolDef, {
        reason: 'Dataframe drop is disabled in this deployment.',
        hint: 'FRED_DATAFRAME_DROP_ENABLED=true',
      });
}

/**
 * @fileoverview Run a single-statement SELECT against canvas dataframes
 * registered by fedreserve_get_observations. Layered SQL gate: framework
 * (single-statement → SELECT only → plan-walk allowlist + denied table
 * functions) plus bridge-layer deny on DuckDB system catalogs. Optional
 * register_as chains the result as a new dataframe with a fresh TTL.
 * @module mcp-server/tools/definitions/fedreserve-dataframe-query
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';

export const fedreserveDataframeQueryTool = tool('fedreserve_dataframe_query', {
  title: 'Query FRED Dataframes',
  description:
    'Run a single-statement SELECT against canvas dataframes registered by fedreserve_get_observations. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported. Reference dataframes by the df_<id> handles returned from fedreserve_get_observations or listed by fedreserve_dataframe_describe. Read-only: writes, DDL, DROP, COPY, PRAGMA, ATTACH, and external-file table functions are rejected. System catalogs are denied at the bridge layer. Optional register_as chains the result as a new dataframe with a fresh TTL. Unavailable when the server sets CANVAS_PROVIDER_TYPE=none.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

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
    sql: z
      .string()
      .min(1)
      .describe(
        'Single-statement SELECT against df_<id> tables. Standard DuckDB SQL — joins, aggregates, window functions, CTEs all supported. BIGINT columns (COUNT/SUM results) serialize as JSON strings — CAST(col AS DOUBLE) in projections for inline arithmetic.',
      ),
    register_as: z
      .string()
      .optional()
      .describe(
        'Persist the result as a new dataframe under this name (df_XXXXX_XXXXX format). Gets a fresh TTL independent of source tables. Use to chain analyses without re-running the source SQL.',
      ),
    preview: z
      .number()
      .int()
      .min(0)
      .max(10000)
      .optional()
      .describe(
        'Rows to include in the immediate response. Defaults to row_limit. Set lower when chaining via register_as and only a sample is needed inline.',
      ),
    row_limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(1000)
      .describe(
        'Cap on unregistered results and inline previews. Default 1000, max 10000. With register_as, the full result is stored on-canvas.',
      ),
  }),

  output: z.object({
    columns: z.array(z.string()).describe('Column names in projection order.'),
    row_count: z
      .number()
      .describe(
        'Provider result row count; may exceed the inline preview. Without register_as, bounded by row_limit, not an uncapped SQL total.',
      ),
    truncated: z
      .literal(true)
      .optional()
      .describe('Set when the SQL result exceeds row_limit without register_as.'),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Materialized rows, bounded by preview / row_limit.'),
    registered_as: z
      .string()
      .optional()
      .describe('Set when register_as was supplied and the new dataframe was materialized.'),
    expires_at: z
      .string()
      .optional()
      .describe('ISO 8601 expiry timestamp for the newly registered dataframe, when applicable.'),
  }),

  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe('Exact SQL result row count, omitted when truncated.'),
  },

  async handler(input, ctx) {
    const bridge = getCanvasBridge();
    if (!bridge) {
      throw ctx.fail('canvas_unavailable', 'DataCanvas is not configured on this server.');
    }

    const { result, meta } = await bridge.query(ctx, input.sql, {
      ...(input.register_as !== undefined && { registerAs: input.register_as }),
      ...(input.preview !== undefined && { preview: input.preview }),
      rowLimit: input.row_limit,
      sourceTool: 'fedreserve_dataframe_query',
      queryParams: { sql: input.sql },
    });

    ctx.log.info('Dataframe query executed', {
      rowCount: result.rowCount,
      returned: result.rows.length,
      registeredAs: meta?.tableName,
    });
    if (!result.truncated) ctx.enrich.total(result.rowCount);

    return {
      columns: result.columns,
      row_count: result.rowCount,
      ...(result.truncated && { truncated: true as const }),
      rows: result.rows,
      registered_as: meta?.tableName,
      expires_at: meta?.expiresAt,
    };
  },

  format: (result) => {
    const capNotice = result.truncated
      ? `Result capped at ${result.row_count} ${result.row_count === 1 ? 'row' : 'rows'}. Narrow the query or use \`register_as\` to materialize the full result.`
      : '';
    // Markdown normalizes line breaks and NULs, and cannot distinguish SQL NULL from empty cells.
    const needsJson = (value: string) => /[\n\r]/.test(value) || value.includes('\0');
    if (
      (result.registered_as !== undefined && needsJson(result.registered_as)) ||
      result.columns.some(needsJson) ||
      result.rows.some((row) =>
        Object.values(row).some(
          (value) => value === null || (typeof value === 'string' && needsJson(value)),
        ),
      )
    ) {
      const json = markdown()
        .codeBlock(JSON.stringify(result, null, 2), 'json')
        .build();
      return [
        {
          type: 'text',
          text: capNotice ? `${json}\n\n${capNotice}` : json,
        },
      ];
    }
    const lines: string[] = [];
    if (result.registered_as) {
      lines.push(
        `Registered as ${markdown().inlineCode(result.registered_as).build()} (expires ${result.expires_at ?? 'unknown'}).`,
      );
    }
    const previewNote =
      result.row_count > result.rows.length
        ? ` (showing ${result.rows.length} of ${result.row_count})`
        : '';
    lines.push(`**${result.row_count} rows**${previewNote}`);
    if (capNotice) lines.push(capNotice);
    lines.push('');

    if (result.rows.length === 0) {
      lines.push('_No rows._');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    const header = `| ${result.columns.map(escapeMarkdownInline).join(' | ')} |`;
    const sep = `| ${result.columns.map(() => '---').join(' | ')} |`;
    lines.push(header, sep);
    for (const row of result.rows) {
      const cells = result.columns.map((c) => {
        const v = row[c];
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return escapeMarkdownInline(v);
        if (typeof v === 'object') return escapeMarkdownInline(JSON.stringify(v));
        return String(v);
      });
      lines.push(`| ${cells.join(' | ')} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

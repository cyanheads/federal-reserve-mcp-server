/**
 * @fileoverview Fetch observation data (date + value pairs) for one or more
 * FRED series over a date range. Multi-series or >500-row results spill to a
 * DataCanvas table and return a `df_<id>` handle for SQL querying via
 * fred_dataframe_query. Degrades gracefully when canvas is unavailable.
 * @module mcp-server/tools/definitions/fred-get-observations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { getFredApiService } from '@/services/fred/fred-service.js';

const SPILLOVER_ROW_THRESHOLD = 500;
const PREVIEW_ROWS = 20;

const ObservationSchema = z.object({
  date: z.string().describe('Observation date (YYYY-MM-DD).'),
  value: z
    .string()
    .describe('Observation value as a string (preserves trailing zeros; "." for missing).'),
});

export const fredGetObservationsTool = tool('fred_get_observations', {
  title: 'Get FRED Series Observations',
  description:
    'Fetch observation data (date + value pairs) for one or more FRED series over a date range. Supports FRED built-in unit transformations (lin, chg, ch1, pch, pc1, pca, cch, cca, log). Multi-series or >500-row results spill to a DataCanvas table — the response includes a `dataset` field with the handle to query via fred_dataframe_query. Observation values are kept as strings to preserve trailing zeros.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'series_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A series ID is not found on FRED.',
      recovery: 'Verify the series ID using fred_search_series and try again.',
    },
    {
      reason: 'frequency_too_high',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Requested frequency aggregation is higher than the series native frequency.',
      recovery: 'Use a lower frequency or omit the frequency parameter.',
    },
    {
      reason: 'no_observations_in_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'Valid series but the date range contains no observations.',
      recovery: 'Expand the date range — the series may start later or end earlier than requested.',
    },
  ],

  input: z.object({
    series_ids: z
      .union([
        z.string().describe('Single series ID (e.g., "UNRATE").'),
        z.array(z.string()).max(10).describe('Array of up to 10 series IDs.'),
      ])
      .describe('One series ID or an array of up to 10 series IDs.'),
    observation_start: z
      .string()
      .optional()
      .describe('Start date for observations (YYYY-MM-DD). Defaults to the series start.'),
    observation_end: z
      .string()
      .optional()
      .describe('End date for observations (YYYY-MM-DD). Defaults to the series end.'),
    units: z
      .enum(['lin', 'chg', 'ch1', 'pch', 'pc1', 'pca', 'cch', 'cca', 'log'])
      .optional()
      .describe(
        'Unit transformation: lin=levels, chg=change, ch1=change from year ago, pch=percent change, pc1=percent change from year ago, pca=compounded annual rate, cch=continuously compounded rate, cca=continuously compounded annual rate, log=natural log.',
      ),
    frequency: z
      .enum([
        'd',
        'w',
        'bw',
        'm',
        'q',
        'sa',
        'a',
        'wef',
        'weth',
        'wew',
        'wetu',
        'wem',
        'wesu',
        'wesa',
        'bwew',
        'bwem',
      ])
      .optional()
      .describe(
        'Frequency for aggregation downsampling (d=daily, w=weekly, m=monthly, q=quarterly, sa=semi-annual, a=annual). Must not be higher than the native series frequency.',
      ),
    aggregation_method: z
      .enum(['avg', 'sum', 'eop'])
      .optional()
      .describe(
        'Aggregation method when downsampling frequency: avg, sum, or eop (end of period).',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Optional canvas ID from a prior fred_get_observations call. Omit to create a fresh table; provide to append to an existing canvas.',
      ),
  }),

  output: z.object({
    series: z
      .array(
        z
          .object({
            series_id: z.string().describe('FRED series ID.'),
            observation_start: z.string().describe('Actual start date of observations returned.'),
            observation_end: z.string().describe('Actual end date of observations returned.'),
            units: z.string().describe('Units applied (after transformation if requested).'),
            observation_count: z.number().describe('Number of observations for this series.'),
            observations: z
              .array(ObservationSchema.describe('One observation: date + value pair.'))
              .describe(
                'Inline observations (all rows for short single-series; preview for spilled).',
              ),
          })
          .describe('Observation results for one series.'),
      )
      .describe('Results per series.'),
    failed: z
      .array(
        z
          .object({
            series_id: z.string().describe('Series ID that failed.'),
            error: z.string().describe('Error message.'),
          })
          .describe('A failed series fetch with its error.'),
      )
      .describe('Series that failed to fetch, with per-ID error details.'),
    dataset: z
      .object({
        name: z
          .string()
          .describe('Canvas table name (df_XXXXX_XXXXX). Pass to fred_dataframe_query.'),
        row_count: z.number().describe('Total rows registered in the canvas table.'),
        expires_at: z.string().describe('ISO 8601 expiry timestamp.'),
        preview_rows: z
          .number()
          .describe('Number of rows shown inline in the observations arrays.'),
        truncated: z
          .boolean()
          .describe('True when the canvas table is a subset of available data.'),
      })
      .optional()
      .describe(
        'Canvas dataset handle — present when results spilled to canvas (multi-series or >500 rows). Pass `name` to fred_dataframe_query for SQL access.',
      ),
    total_observations: z.number().describe('Total observation count across all series.'),
    message: z
      .string()
      .optional()
      .describe(
        'Informational note — present when canvas is unavailable or results were truncated.',
      ),
  }),

  async handler(input, ctx) {
    const ids = Array.isArray(input.series_ids) ? input.series_ids : [input.series_ids];
    ctx.log.info('fred_get_observations', { count: ids.length });

    const sharedParams = {
      ...(input.observation_start && { observation_start: input.observation_start }),
      ...(input.observation_end && { observation_end: input.observation_end }),
      ...(input.units && { units: input.units }),
      ...(input.frequency && { frequency: input.frequency }),
      ...(input.aggregation_method && { aggregation_method: input.aggregation_method }),
    };

    const results = await Promise.allSettled(
      ids.map((series_id) =>
        getFredApiService().getObservations({ series_id, ...sharedParams }, ctx),
      ),
    );

    const seriesResults: {
      series_id: string;
      observation_start: string;
      observation_end: string;
      units: string;
      observation_count: number;
      observations: { date: string; value: string }[];
    }[] = [];
    const failed: { series_id: string; error: string }[] = [];

    for (const [i, result] of results.entries()) {
      const series_id = ids[i]!;
      if (result.status === 'fulfilled') {
        const resp = result.value;
        const obs = resp.observations ?? [];

        if (ids.length === 1 && obs.length === 0) {
          throw ctx.fail(
            'no_observations_in_range',
            `No observations found for ${series_id} in the requested date range.`,
            { ...ctx.recoveryFor('no_observations_in_range') },
          );
        }

        seriesResults.push({
          series_id,
          observation_start: resp.observation_start ?? '',
          observation_end: resp.observation_end ?? '',
          units: resp.units ?? '',
          observation_count: obs.length,
          observations: obs.map((o) => ({ date: o.date, value: o.value })),
        });
      } else {
        const err = result.reason;
        const msg = err instanceof Error ? err.message : String(err);

        if (ids.length === 1) {
          const lower = msg.toLowerCase();
          // FRED returns HTTP 400 for unknown series — check body for the error message
          const errData =
            typeof err === 'object' && err !== null && 'data' in err
              ? (err as { data?: Record<string, unknown> }).data
              : undefined;
          const fredBody = String(errData?.body ?? '').toLowerCase();
          const isNotFound =
            lower.includes('not found') ||
            lower.includes('404') ||
            fredBody.includes('does not exist') ||
            fredBody.includes('is not in the database');
          if (isNotFound) {
            throw ctx.fail('series_not_found', `Series ${series_id} not found on FRED.`, {
              ...ctx.recoveryFor('series_not_found'),
            });
          }
          if (lower.includes('frequency')) {
            throw ctx.fail(
              'frequency_too_high',
              `Frequency aggregation error for ${series_id}: ${msg}`,
              { ...ctx.recoveryFor('frequency_too_high') },
            );
          }
          // Any other single-series upstream error — surface as series_not_found so
          // the caller gets a named error code with an actionable recovery hint.
          throw ctx.fail('series_not_found', `Series ${series_id} could not be fetched: ${msg}`, {
            ...ctx.recoveryFor('series_not_found'),
          });
        }
        failed.push({ series_id, error: msg });
      }
    }

    const totalObservations = seriesResults.reduce((sum, s) => sum + s.observation_count, 0);
    const shouldSpill = ids.length > 1 || totalObservations > SPILLOVER_ROW_THRESHOLD;
    const bridge = getCanvasBridge();

    if (shouldSpill && bridge) {
      // Build flat rows for canvas: { series_id, date, value }
      const allRows = seriesResults.flatMap((s) =>
        s.observations.map((o) => ({ series_id: s.series_id, date: o.date, value: o.value })),
      );

      const registered = await bridge.registerDataframe(ctx, {
        rows: allRows,
        sourceTool: 'fred_get_observations',
        queryParams: {
          series_ids: ids,
          ...sharedParams,
        },
      });

      // Keep only preview in inline arrays
      const previewCount = registered ? PREVIEW_ROWS : (seriesResults[0]?.observations.length ?? 0);
      let rowsEmitted = 0;
      for (const s of seriesResults) {
        const take = Math.max(0, previewCount - rowsEmitted);
        s.observations = s.observations.slice(0, take);
        s.observation_count = s.observations.length;
        rowsEmitted += s.observations.length;
      }

      return {
        series: seriesResults,
        failed,
        total_observations: totalObservations,
        ...(registered
          ? {
              dataset: {
                name: registered.tableName,
                row_count: registered.rowCount,
                expires_at: registered.expiresAt,
                preview_rows: previewCount,
                truncated: false,
              },
            }
          : {
              message: `Canvas registration failed — showing up to ${PREVIEW_ROWS} rows inline per series. Total observations: ${totalObservations}.`,
            }),
      };
    }

    if (shouldSpill && !bridge) {
      // Canvas not available — truncate inline
      const take = PREVIEW_ROWS;
      let rowsEmitted = 0;
      for (const s of seriesResults) {
        const sliceTo = Math.max(0, take - rowsEmitted);
        s.observations = s.observations.slice(0, sliceTo);
        s.observation_count = s.observations.length;
        rowsEmitted += s.observations.length;
      }
      return {
        series: seriesResults,
        failed,
        total_observations: totalObservations,
        message: `Canvas is not enabled (set CANVAS_PROVIDER_TYPE=duckdb). Showing up to ${PREVIEW_ROWS} rows inline. Total: ${totalObservations} observations across ${ids.length} series.`,
      };
    }

    // Single series, short result — inline everything
    return { series: seriesResults, failed, total_observations: totalObservations };
  },

  format: (result) => {
    const lines: string[] = [];

    if (result.dataset) {
      lines.push(`**Canvas dataset:** \`${result.dataset.name}\``);
      lines.push(
        `Rows: ${result.dataset.row_count} | Expires: ${result.dataset.expires_at} | Preview rows: ${result.dataset.preview_rows} | Truncated: ${result.dataset.truncated}`,
      );
      lines.push(
        'Pass the dataset name to `fred_dataframe_query` for SQL access to the full result set.\n',
      );
    }
    if (result.message) {
      lines.push(`> ${result.message}\n`);
    }

    lines.push(`**Total observations:** ${result.total_observations}\n`);

    for (const s of result.series) {
      lines.push(`### ${s.series_id}`);
      lines.push(
        `Units: ${s.units} | Range: ${s.observation_start} → ${s.observation_end} | Count: ${s.observation_count}`,
      );
      if (s.observations.length > 0) {
        lines.push('');
        lines.push('| Date | Value |');
        lines.push('| --- | --- |');
        for (const o of s.observations) {
          lines.push(`| ${o.date} | ${o.value} |`);
        }
      }
      lines.push('');
    }

    if (result.failed.length > 0) {
      lines.push(`**${result.failed.length} failed:**`);
      for (const f of result.failed) {
        lines.push(`- ${f.series_id}: ${f.error}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

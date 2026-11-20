/**
 * @fileoverview Fetch observation data (date + value pairs) for one or more
 * FRED series over a date range. Multi-series or >500-row results spill to a
 * DataCanvas table and return a `df_<id>` handle for SQL querying via
 * fedreserve_dataframe_query. Degrades gracefully when canvas is unavailable.
 * @module mcp-server/tools/definitions/fedreserve-get-observations
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';
import { prepareSeriesBatch } from '@/mcp-server/tools/prepare-series-batch.js';
import { getCanvasBridge, toDatasetField } from '@/services/canvas-bridge/canvas-bridge.js';
import { FredDomainError } from '@/services/fred/fred-error.js';
import { getFredApiService } from '@/services/fred/fred-service.js';

const SPILLOVER_ROW_THRESHOLD = 500;
const PREVIEW_ROWS = 20;
const INLINE_PAGE_SIZE = 20;
const FREQUENCY_RANK = new Map([
  ['d', 0],
  ['w', 1],
  ['bw', 2],
  ['m', 3],
  ['q', 4],
  ['sa', 5],
  ['a', 6],
]);
const UNIT_LABELS = new Map([
  ['lin', 'Levels (No transformation)'],
  ['chg', 'Change'],
  ['ch1', 'Change from Year Ago'],
  ['pch', 'Percent Change'],
  ['pc1', 'Percent Change from Year Ago'],
  ['pca', 'Compounded Annual Rate of Change'],
  ['cch', 'Continuously Compounded Rate of Change'],
  ['cca', 'Continuously Compounded Annual Rate of Change'],
  ['log', 'Natural Log'],
]);

const OPTIONAL_METADATA_ERRORS = new Set([
  JsonRpcErrorCode.NotFound,
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.RateLimited,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.Unauthorized,
  JsonRpcErrorCode.Forbidden,
  JsonRpcErrorCode.SerializationError,
]);
const OptionalMetadataText = z.string().optional().catch(undefined);
const SeriesMetadataEnvelope = z.object({
  seriess: z.array(
    z.object({
      units: OptionalMetadataText,
      frequency_short: OptionalMetadataText,
      seasonal_adjustment: OptionalMetadataText,
      seasonal_adjustment_short: OptionalMetadataText,
    }),
  ),
});

function frequencyRank(frequency: string | undefined): number | undefined {
  const code = frequency?.toLowerCase();
  if (code?.startsWith('we')) return FREQUENCY_RANK.get('w');
  if (code?.startsWith('bwe')) return FREQUENCY_RANK.get('bw');
  return code ? FREQUENCY_RANK.get(code) : undefined;
}

/** Form clients may send an unset date as an empty string. */
const OptionalObservationDateSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.iso
    .date({
      error: (issue) =>
        `Must be a valid calendar date in YYYY-MM-DD format; received ${String(issue.input)}.`,
    })
    .optional(),
);

/**
 * Show up to PREVIEW_ROWS across series whose full pages are already staged.
 */
function truncateInline(
  series: z.infer<typeof SeriesObservationsSchema>[],
  sortOrder: 'asc' | 'desc',
): void {
  const perSeries = Math.floor(PREVIEW_ROWS / series.length);
  for (const s of series) {
    s.observations =
      sortOrder === 'desc' ? s.observations.slice(0, perSeries) : s.observations.slice(-perSeries);
  }
}

const ObservationSchema = z.object({
  date: z.string().describe('Observation date (YYYY-MM-DD).'),
  value: z
    .string()
    .describe('Observation value as a string (preserves trailing zeros; "." for missing).'),
});

function observationPage(observations: z.infer<typeof ObservationSchema>[]) {
  let observation_start: string | null = null;
  let observation_end: string | null = null;
  for (const { date } of observations) {
    if (observation_start === null || date < observation_start) observation_start = date;
    if (observation_end === null || date > observation_end) observation_end = date;
  }
  return {
    observation_start,
    observation_end,
    observation_count: observations.length,
    observations,
  };
}

const SeriesObservationsSchema = z.object({
  series_id: z.string().describe('FRED series ID.'),
  observation_start: z
    .string()
    .nullable()
    .describe('Earliest date in the full fetched page, before preview slicing. Null when empty.'),
  observation_end: z
    .string()
    .nullable()
    .describe('Latest date in the full fetched page, before preview slicing. Null when empty.'),
  units: z.string().describe('FRED value transformation code, such as lin or pc1.'),
  units_label: z.string().optional().describe('Human-readable label for the FRED transformation.'),
  series_units: z
    .string()
    .optional()
    .describe('Native unit of measure, when available from series metadata.'),
  seasonal_adjustment: z
    .string()
    .optional()
    .describe('Seasonal adjustment and annual-rate basis of the native series, when available.'),
  observation_count: z
    .number()
    .describe('Number of observations fetched for this series, before preview slicing.'),
  observations: z
    .array(ObservationSchema.describe('One observation: date + value pair.'))
    .describe(
      'Inline observations. When previewed, contains the newest fetched rows in the requested order.',
    ),
});

/** Build the advertised batch limit from the startup configuration. */
export function buildFedreserveGetObservationsTool(clampLimits: boolean) {
  return tool('fedreserve_get_observations', {
    title: 'Get FRED Series Observations',
    description:
      'Fetch dated FRED values as strings, preserving trailing zeros. Use sort_order: desc with a small limit for recent observations. Paging applies to each series. Process up to 10 normalized IDs per call; request any deferred_ids separately. Nonempty multi-series results and single-series results over 500 rows can spill to DataCanvas. Use dataset.name with fedreserve_dataframe_describe, then SELECT from that name with fedreserve_dataframe_query.',
    annotations: { readOnlyHint: true, openWorldHint: true },

    errors: [
      {
        reason: 'series_not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'A series ID is not found on FRED.',
        recovery: 'Verify the series ID using fedreserve_search_series and try again.',
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
        when: 'A single series has no observations at the requested offset and date range.',
        recovery: 'Use a smaller offset or expand the observation date range.',
      },
      {
        reason: 'invalid_series_ids',
        code: JsonRpcErrorCode.ValidationError,
        when: 'No nonempty series IDs remain after normalization, or the accepted batch limit is exceeded.',
        recovery:
          'Supply nonempty FRED IDs as a comma-separated string or array within the advertised batch limit.',
        thrownBy: 'service',
      },
      {
        reason: 'invalid_observation_range',
        code: JsonRpcErrorCode.ValidationError,
        when: 'observation_start is later than observation_end.',
        recovery: 'Set observation_start on or before observation_end, or omit either date.',
      },
      {
        reason: 'partial_failure',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'Every processed ID in a multi-series batch failed.',
        recovery: 'Review the per-series errors and retry failed IDs individually.',
      },
    ],

    input: z.object({
      series_ids: z
        .union([
          z.string().min(1).describe('One ID or comma-separated IDs (e.g., "UNRATE,GDP").'),
          z
            .array(z.string())
            .min(1)
            .max(clampLimits ? 100 : 10)
            .describe('Series IDs; comma-separated entries are accepted.'),
        ])
        .describe(
          clampLimits
            ? 'Up to 100 IDs; trimmed, uppercased and deduplicated. Process the first 10 and return the rest in deferred_ids.'
            : 'Up to 10 IDs; trimmed, uppercased and deduplicated.',
        ),
      observation_start: OptionalObservationDateSchema.describe(
        'Start date for observations (YYYY-MM-DD). Defaults to the series start.',
      ),
      observation_end: OptionalObservationDateSchema.describe(
        'End date for observations (YYYY-MM-DD). Defaults to the series end.',
      ),
      units: z
        .enum([...UNIT_LABELS.keys()])
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
      sort_order: z
        .enum(['asc', 'desc'])
        .optional()
        .describe(
          'Date order for each series, oldest first (asc, default) or newest first (desc).',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .optional()
        .describe(
          'Page size per series. If omitted, fetch the full upstream page with canvas or up to 20 rows per series inline.',
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Skip this many observations in the requested sort order for each series.'),
    }),

    /** FRED's own `/series/observations` parameter is the singular `series_id`. */
    inputAliases: { series_id: 'series_ids' },

    output: z.object({
      series: z
        .array(SeriesObservationsSchema.describe('Observation results for one series.'))
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
      deferred_ids: z
        .array(z.string().describe('Normalized series ID to request next.'))
        .optional()
        .describe('Unprocessed IDs beyond the 10-ID processing limit.'),
      dataset: z
        .object({
          name: z
            .string()
            .describe(
              'Canvas table name (df_XXXXX_XXXXX). Describe with fedreserve_dataframe_describe, then SELECT from this name with fedreserve_dataframe_query.',
            ),
          row_count: z.number().describe('Total rows registered in the canvas table.'),
          expires_at: z.string().describe('ISO 8601 expiry timestamp.'),
          preview_rows: z
            .number()
            .describe('Number of rows shown inline in the observations arrays.'),
          truncated: z
            .boolean()
            .describe('True when fetched observations were omitted from the canvas table.'),
        })
        .optional()
        .describe(
          'Fresh canvas dataset — present after successful spill registration (multi-series or >500 rows). Pass name to fedreserve_dataframe_describe, then use it in fedreserve_dataframe_query SQL.',
        ),
      total_observations: z.number().describe('Total observation count across all series.'),
      message: z
        .string()
        .optional()
        .describe(
          'Informational note — present when canvas is unavailable or results were truncated.',
        ),
    }),

    enrichment: {
      notice: z
        .string()
        .optional()
        .describe('Aggregation guidance or executable describe and query steps for staged rows.'),
      totalCount: z
        .number()
        .optional()
        .describe(
          'Total matching observations reported by FRED across the processed series before paging.',
        ),
    },

    async handler(input, ctx) {
      const { ids, deferredIds } = prepareSeriesBatch(input.series_ids, 10, clampLimits, ctx);
      if (
        input.observation_start &&
        input.observation_end &&
        input.observation_start > input.observation_end
      ) {
        throw ctx.fail(
          'invalid_observation_range',
          'observation_start must be on or before observation_end.',
        );
      }
      ctx.signal.throwIfAborted();
      ctx.log.info('fedreserve_get_observations', { count: ids.length });

      const bridge = getCanvasBridge();
      const limit = input.limit ?? (bridge ? undefined : INLINE_PAGE_SIZE);
      const requestedRank = frequencyRank(input.frequency);
      const notices: string[] = [];
      if (input.aggregation_method && !input.frequency) {
        notices.push(
          'The aggregation_method applies only when frequency is set. Returned observations without frequency aggregation.',
        );
      }
      const sharedParams = {
        ...(input.observation_start && { observation_start: input.observation_start }),
        ...(input.observation_end && { observation_end: input.observation_end }),
        ...(input.units && { units: input.units }),
        ...(input.frequency && { frequency: input.frequency }),
        ...(input.frequency &&
          input.aggregation_method && { aggregation_method: input.aggregation_method }),
        ...(input.sort_order && { sort_order: input.sort_order }),
        ...(limit !== undefined && { limit }),
        ...(input.offset !== undefined && { offset: input.offset }),
      };

      const fred = getFredApiService();
      const results = await Promise.all(
        ids.map(async (series_id) => {
          const [primary, metadata] = await Promise.allSettled([
            fred.getObservations({ series_id, ...sharedParams }, ctx),
            fred.getSeriesById(series_id, ctx, 'optional'),
          ]);
          return { series_id, primary, metadata };
        }),
      );
      ctx.signal.throwIfAborted();

      const seriesResults: z.infer<typeof SeriesObservationsSchema>[] = [];
      const failed: { series_id: string; error: string }[] = [];
      const availableCounts = new Map<string, number>();

      for (const { series_id, primary, metadata } of results) {
        if (primary.status === 'rejected') {
          const error: unknown = primary.reason;
          if (
            error instanceof Error &&
            (error.name === 'AbortError' ||
              (error instanceof McpError && error.code === JsonRpcErrorCode.RequestCancelled))
          )
            throw error;
          if (ids.length === 1) {
            if (error instanceof FredDomainError) {
              if (error.reason === 'series_not_found')
                throw ctx.fail('series_not_found', error.message);
              if (error.reason === 'frequency_too_high')
                throw ctx.fail('frequency_too_high', error.message);
            }
            throw error;
          }
          failed.push({ series_id, error: error instanceof Error ? error.message : String(error) });
          continue;
        }

        const resp = primary.value;
        const obs = resp.observations ?? [];
        if (ids.length === 1 && obs.length === 0) {
          throw ctx.fail(
            'no_observations_in_range',
            input.offset
              ? `No observations found for ${series_id} at offset ${input.offset} in the requested date range.`
              : `No observations found for ${series_id} in the requested date range.`,
          );
        }

        if (metadata.status === 'rejected') {
          const error: unknown = metadata.reason;
          if (!(error instanceof McpError) || !OPTIONAL_METADATA_ERRORS.has(error.code))
            throw error;
        }
        const seriesMetadata =
          metadata.status === 'fulfilled'
            ? SeriesMetadataEnvelope.safeParse(metadata.value).data?.seriess[0]
            : undefined;
        const seriesUnits = seriesMetadata?.units;
        const seasonalAdjustment = seriesMetadata?.seasonal_adjustment;
        const units = resp.units ?? '';
        const unitsLabel = UNIT_LABELS.get(units);
        const nativeRank = frequencyRank(seriesMetadata?.frequency_short);
        if (
          obs.length > 0 &&
          input.aggregation_method === 'sum' &&
          (input.units === undefined || input.units === 'lin') &&
          requestedRank !== undefined &&
          nativeRank !== undefined &&
          requestedRank > nativeRank &&
          (seriesMetadata?.seasonal_adjustment_short === 'SAAR' ||
            (seriesUnits && /\bannual rate\b/i.test(seriesUnits)))
        ) {
          notices.push(
            `${series_id}: sum adds annualized observations. Use avg to preserve the annual-rate basis.`,
          );
        }
        if (typeof resp.count === 'number') availableCounts.set(series_id, resp.count);
        seriesResults.push({
          series_id,
          ...observationPage(obs.map((o) => ({ date: o.date, value: o.value }))),
          units,
          ...(unitsLabel && { units_label: unitsLabel }),
          ...(seriesUnits && { series_units: seriesUnits }),
          ...(seasonalAdjustment && { seasonal_adjustment: seasonalAdjustment }),
        });
      }

      const deferred = deferredIds.length > 0 ? { deferred_ids: deferredIds } : {};
      if (seriesResults.length === 0) {
        const details = failed.map(({ series_id, error }) => `${series_id}: ${error}`).join('\n');
        const deferredDetails =
          deferredIds.length > 0 ? `\nDeferred IDs: ${deferredIds.join(', ')}.` : '';
        throw ctx.fail(
          'partial_failure',
          `All ${ids.length} processed series failed.\n${details}${deferredDetails}`,
          { failed, ...deferred },
        );
      }
      const fetched = seriesResults.reduce((sum, s) => sum + s.observation_count, 0);
      const shouldSpill = fetched > 0 && (ids.length > 1 || fetched > SPILLOVER_ROW_THRESHOLD);
      const registered = shouldSpill
        ? await bridge?.registerDataframe(ctx, {
            rows: seriesResults.flatMap((s) =>
              s.observations.map((o) => ({ series_id: s.series_id, date: o.date, value: o.value })),
            ),
            sourceTool: 'fedreserve_get_observations',
            queryParams: { series_ids: ids, ...sharedParams },
          })
        : undefined;
      ctx.signal.throwIfAborted();

      const registrationFailed = shouldSpill && bridge !== undefined && !registered;
      if (registrationFailed && limit === undefined) {
        for (const series of seriesResults) {
          Object.assign(series, observationPage(series.observations.slice(0, INLINE_PAGE_SIZE)));
        }
      }
      if (
        (limit !== undefined || input.offset !== undefined || registrationFailed) &&
        availableCounts.size === ids.length
      ) {
        ctx.enrich.total([...availableCounts.values()].reduce((sum, count) => sum + count, 0));
      }

      const output = {
        series: seriesResults,
        failed,
        total_observations: seriesResults.reduce((sum, s) => sum + s.observation_count, 0),
        ...deferred,
      };
      const sortOrder = input.sort_order ?? 'asc';
      if (registered) {
        truncateInline(seriesResults, sortOrder);
        const previewCount = seriesResults.reduce(
          (sum, series) => sum + series.observations.length,
          0,
        );
        notices.push(
          `Staged ${registered.rowCount} rows in ${registered.tableName}; showing ${previewCount} rows inline. Call fedreserve_dataframe_describe with ${JSON.stringify({ name: registered.tableName })}, then fedreserve_dataframe_query with ${JSON.stringify({ sql: `SELECT * FROM ${registered.tableName}` })}.`,
        );
        ctx.enrich.notice(notices.join(' '));
        return {
          ...output,
          dataset: {
            ...toDatasetField(registered),
            preview_rows: previewCount,
            truncated: false,
          },
        };
      }

      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
      const offset = input.offset ?? 0;
      const nextOffsets = seriesResults.flatMap(({ series_id, observation_count }) => {
        const nextOffset = offset + observation_count;
        const available = availableCounts.get(series_id);
        return observation_count > 0 && available !== undefined && nextOffset < available
          ? [`${series_id}: ${nextOffset}`]
          : [];
      });
      const guidance: string[] = [];
      if (registrationFailed) {
        guidance.push('Canvas registration failed.');
      } else if (shouldSpill && !bridge) {
        guidance.push('Canvas is unavailable.');
      }
      if (guidance.length > 0) {
        guidance.push(
          output.total_observations === fetched
            ? `Showing all ${fetched} fetched observations inline.`
            : `Showing ${output.total_observations} observations inline.`,
        );
      }
      if (nextOffsets.length > 0) {
        const pageLimit = registrationFailed ? (limit ?? INLINE_PAGE_SIZE) : limit;
        const keepLimit = pageLimit === undefined ? '' : ` and limit ${pageLimit}`;
        guidance.push(
          `Keep the same filters, sort_order ${sortOrder}${keepLimit}. Request each series with its next offset (${nextOffsets.join(', ')}).`,
        );
      }
      return guidance.length > 0 ? { ...output, message: guidance.join(' ') } : output;
    },

    format: (result) => {
      const lines: string[] = [];

      if (result.dataset) {
        lines.push(`**Canvas dataset:** ${markdown().inlineCode(result.dataset.name).build()}`);
        lines.push(
          `Rows: ${result.dataset.row_count} | Expires: ${escapeMarkdownInline(result.dataset.expires_at)} | Preview rows: ${result.dataset.preview_rows} | Truncated: ${result.dataset.truncated}`,
        );
      }
      if (result.message) {
        lines.push(`> ${escapeMarkdownInline(result.message)}\n`);
      }

      lines.push(`**Total observations:** ${result.total_observations}\n`);

      for (const s of result.series) {
        const title = `${escapeMarkdownInline(s.series_id)}`;
        lines.push(title.includes('\n') ? title : `### ${title}`);
        const range =
          s.observation_start !== null && s.observation_end !== null
            ? ` | Range: ${escapeMarkdownInline(s.observation_start)} → ${escapeMarkdownInline(s.observation_end)}`
            : '';
        const unitsLabel = s.units_label ? ` (${escapeMarkdownInline(s.units_label)})` : '';
        const seriesUnits = s.series_units
          ? ` | Native series units: ${escapeMarkdownInline(s.series_units)}`
          : '';
        const seasonalAdjustment = s.seasonal_adjustment
          ? ` | Native series seasonal adjustment: ${escapeMarkdownInline(s.seasonal_adjustment)}`
          : '';
        lines.push(
          `Transformation: ${escapeMarkdownInline(s.units)}${unitsLabel}${seriesUnits}${seasonalAdjustment}${range} | Count: ${s.observation_count}`,
        );
        if (s.observations.length > 0) {
          lines.push('');
          lines.push('| Date | Value |');
          lines.push('| --- | --- |');
          for (const o of s.observations) {
            lines.push(`| ${escapeMarkdownInline(o.date)} | ${escapeMarkdownInline(o.value)} |`);
          }
        }
        lines.push('');
      }

      if (result.failed.length > 0) {
        lines.push(`**${result.failed.length} failed:**`);
        for (const f of result.failed) {
          lines.push(`- ${escapeMarkdownInline(f.series_id)}: ${escapeMarkdownInline(f.error)}`);
        }
      }

      if (result.deferred_ids?.length)
        lines.push(
          `**Deferred IDs:** ${result.deferred_ids.map(escapeMarkdownInline).join(', ')}. Request these IDs in the next call.`,
        );
      return [{ type: 'text', text: lines.join('\n').trimEnd() }];
    },
  });
}

/** Default batch policy; startup uses the configured factory. */
export const fedreserveGetObservationsTool = buildFedreserveGetObservationsTool(true);

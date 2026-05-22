/**
 * @fileoverview Retrieve metadata for one or more FRED series — title, units,
 * frequency, seasonal adjustment, observation range, popularity, and notes.
 * Fires parallel upstream requests (FRED has no batch endpoint) and returns
 * partial success when some IDs fail.
 * @module mcp-server/tools/definitions/fred-get-series
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFredApiService } from '@/services/fred/fred-service.js';

const SeriesMetaSchema = z.object({
  id: z.string().describe('FRED series ID.'),
  title: z.string().describe('Series title.'),
  units: z.string().describe('Units of measurement.'),
  frequency: z.string().describe('Data frequency.'),
  seasonal_adjustment: z.string().describe('Seasonal adjustment status.'),
  last_updated: z.string().describe('ISO 8601 last update date.'),
  observation_start: z.string().optional().describe('Earliest available observation date.'),
  observation_end: z.string().optional().describe('Latest available observation date.'),
  popularity: z.number().optional().describe('Popularity score (0–100) when provided.'),
  notes: z.string().optional().describe('Free-text notes from FRED when provided.'),
});

export const fredGetSeriesTool = tool('fred_get_series', {
  title: 'Get FRED Series Metadata',
  description:
    'Retrieve metadata for one or more FRED series — title, units, frequency, seasonal adjustment status, observation range, popularity, and notes. Accepts up to 50 series IDs; fires parallel upstream requests (no batch endpoint exists). Returns partial success when some IDs fail.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'series_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'A series ID exists in format but FRED returns no data for it.',
      recovery: 'Verify the series ID is correct using fred_search_series and try again.',
    },
    {
      reason: 'partial_failure',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Some IDs in the batch returned errors; partial results are returned.',
      recovery: 'Check the failed array for per-ID errors and retry failed IDs individually.',
    },
  ],

  input: z.object({
    series_ids: z
      .union([
        z.string().describe('Single series ID (e.g., "UNRATE").'),
        z.array(z.string()).max(50).describe('Array of up to 50 series IDs.'),
      ])
      .describe('One series ID or an array of up to 50 series IDs.'),
  }),

  output: z.object({
    series: z
      .array(SeriesMetaSchema.describe('Metadata for one FRED series.'))
      .describe('Successfully resolved series metadata.'),
    failed: z
      .array(
        z
          .object({
            id: z.string().describe('Series ID that failed.'),
            error: z.string().describe('Error message.'),
          })
          .describe('A failed series fetch with its error.'),
      )
      .describe('Series IDs that could not be resolved, with per-ID error details.'),
  }),

  async handler(input, ctx) {
    const ids = Array.isArray(input.series_ids) ? input.series_ids : [input.series_ids];
    ctx.log.info('fred_get_series', { count: ids.length });

    const results = await Promise.allSettled(
      ids.map((id) => getFredApiService().getSeriesById(id, ctx)),
    );

    const series: z.infer<typeof SeriesMetaSchema>[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const [i, result] of results.entries()) {
      const id = ids[i]!;
      if (result.status === 'fulfilled') {
        const raw = result.value.seriess?.[0];
        if (!raw) {
          if (ids.length === 1) {
            throw ctx.fail('series_not_found', `Series ${id} not found on FRED.`, {
              ...ctx.recoveryFor('series_not_found'),
            });
          }
          failed.push({ id, error: `Series ${id} not found on FRED.` });
        } else {
          series.push({
            id: raw.id,
            title: raw.title ?? '',
            units: raw.units ?? '',
            frequency: raw.frequency ?? '',
            seasonal_adjustment: raw.seasonal_adjustment ?? '',
            last_updated: raw.last_updated ?? '',
            ...(raw.observation_start && { observation_start: raw.observation_start }),
            ...(raw.observation_end && { observation_end: raw.observation_end }),
            ...(typeof raw.popularity === 'number' && { popularity: raw.popularity }),
            ...(raw.notes?.trim() && { notes: raw.notes.trim() }),
          });
        }
      } else {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failed.push({ id, error: msg });
      }
    }

    if (series.length === 0 && failed.length > 0) {
      throw ctx.fail('partial_failure', `All ${ids.length} series IDs failed to resolve.`, {
        ...ctx.recoveryFor('partial_failure'),
      });
    }

    return { series, failed };
  },

  format: (result) => {
    const lines: string[] = [];
    for (const s of result.series) {
      lines.push(`### ${s.id}: ${s.title}`);
      lines.push(
        `**Units:** ${s.units} | **Frequency:** ${s.frequency} | **Seasonal adj.:** ${s.seasonal_adjustment}`,
      );
      if (s.observation_start || s.observation_end) {
        lines.push(`**Range:** ${s.observation_start ?? '?'} → ${s.observation_end ?? '?'}`);
      }
      lines.push(
        `**Last updated:** ${s.last_updated}${s.popularity !== undefined ? ` | **Popularity:** ${s.popularity}` : ''}`,
      );
      if (s.notes) lines.push(`> ${s.notes}`);
      lines.push('');
    }
    if (result.failed.length > 0) {
      lines.push(`**${result.failed.length} failed:**`);
      for (const f of result.failed) {
        lines.push(`- ${f.id}: ${f.error}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

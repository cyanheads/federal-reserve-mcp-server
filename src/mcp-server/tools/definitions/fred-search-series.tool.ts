/**
 * @fileoverview Full-text search across FRED series titles, units, frequency,
 * and tags. Entry point for resolving economic topics to series IDs.
 * @module mcp-server/tools/definitions/fred-search-series
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getFredApiService } from '@/services/fred/fred-service.js';

export const fredSearchSeriesTool = tool('fred_search_series', {
  title: 'Search FRED Series',
  description:
    'Search FRED series by full-text query across titles, tags, and notes. Returns matching series IDs with titles, units, frequency, and last-updated dates for use in follow-up observation or metadata calls. Supports post-search filtering by frequency, units, or seasonal adjustment status. To find series for a specific release, use fred_get_release instead.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  input: z.object({
    query: z.string().min(1).describe('Search terms.'),
    search_type: z
      .enum(['full_text', 'series_id'])
      .optional()
      .describe('Search mode — full_text (default) or series_id.'),
    filter_variable: z
      .enum(['frequency', 'units', 'seasonal_adjustment'])
      .optional()
      .describe('Post-search filter dimension.'),
    filter_value: z.string().optional().describe('Value for filter_variable.'),
    tag_names: z
      .string()
      .optional()
      .describe('Semicolon-delimited list of tag names to filter by.'),
    limit: z.number().int().min(1).max(1000).optional().describe('Max results (default 1000).'),
    offset: z.number().int().min(0).optional().describe('Pagination offset.'),
  }),

  output: z.object({
    count: z.number().describe('Total matching series count.'),
    offset: z.number().describe('Pagination offset applied.'),
    limit: z.number().describe('Limit applied.'),
    series: z
      .array(
        z
          .object({
            id: z.string().describe('FRED series ID (e.g., UNRATE).'),
            title: z.string().describe('Series title.'),
            units: z.string().describe('Units of measurement.'),
            frequency: z.string().describe('Data frequency.'),
            seasonal_adjustment: z.string().describe('Seasonal adjustment status.'),
            last_updated: z.string().describe('ISO 8601 date of last update.'),
            popularity: z.number().optional().describe('Popularity score (0–100) when provided.'),
          })
          .describe('One matching FRED series.'),
      )
      .describe('Matching series.'),
  }),

  async handler(input, ctx) {
    ctx.log.info('fred_search_series', { query: input.query });
    const resp = await getFredApiService().searchSeries(
      {
        query: input.query,
        ...(input.search_type && { search_type: input.search_type }),
        ...(input.filter_variable && { filter_variable: input.filter_variable }),
        ...(input.filter_value && { filter_value: input.filter_value }),
        ...(input.tag_names && { tag_names: input.tag_names }),
        ...(input.limit !== undefined && { limit: input.limit }),
        ...(input.offset !== undefined && { offset: input.offset }),
      },
      ctx,
    );

    return {
      count: resp.count,
      offset: resp.offset,
      limit: resp.limit,
      series: (resp.seriess ?? []).map((s) => ({
        id: s.id,
        title: s.title ?? '',
        units: s.units ?? '',
        frequency: s.frequency ?? '',
        seasonal_adjustment: s.seasonal_adjustment ?? '',
        last_updated: s.last_updated ?? '',
        ...(typeof s.popularity === 'number' && { popularity: s.popularity }),
      })),
    };
  },

  format: (result) => {
    if (result.series.length === 0) {
      return [
        {
          type: 'text',
          text: `No series found. Total count: ${result.count}. Offset: ${result.offset}, Limit: ${result.limit}.`,
        },
      ];
    }
    const lines = [
      `**${result.count} total match(es) — showing ${result.series.length} (offset ${result.offset}, limit ${result.limit})**\n`,
    ];
    for (const s of result.series) {
      lines.push(`### ${s.id}: ${s.title}`);
      lines.push(
        `**Units:** ${s.units} | **Frequency:** ${s.frequency} | **Seasonal adj.:** ${s.seasonal_adjustment}`,
      );
      lines.push(
        `**Last updated:** ${s.last_updated}${s.popularity !== undefined ? ` | **Popularity:** ${s.popularity}` : ''}`,
      );
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

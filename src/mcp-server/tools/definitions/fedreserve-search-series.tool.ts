/**
 * @fileoverview Full-text search across FRED series titles, units, frequency,
 * and tags. Entry point for resolving economic topics to series IDs.
 * @module mcp-server/tools/definitions/fedreserve-search-series
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getFredApiService } from '@/services/fred/fred-service.js';

const DEFAULT_LIMIT = 20;
const MAX_SEARCH_OFFSET = 4000;
const SEARCH_WINDOW = 5000;

const FREQUENCIES = new Map(
  [
    'Daily',
    'Weekly',
    'Biweekly',
    'Monthly',
    'Quarterly',
    'Semiannual',
    'Annual',
    'Not Applicable',
  ].map((value) => [value.toLowerCase(), value]),
);
const SEASONAL_ADJUSTMENTS = new Map(
  ['Seasonally Adjusted', 'Not Seasonally Adjusted', 'Seasonally Adjusted Annual Rate'].map(
    (value) => [value.toLowerCase(), value],
  ),
);

export const fedreserveSearchSeriesTool = tool('fedreserve_search_series', {
  title: 'Search FRED Series',
  description:
    'Search FRED series by full-text query across titles, tags, and notes. Returns matching series IDs with titles, units, frequency, and last-updated dates for use in follow-up observation or metadata calls. Supports post-search filtering by frequency, units, or seasonal adjustment status. To find series for a specific release, use fedreserve_get_release instead.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filter member is supplied without a complete nonblank filter pair.',
      recovery: 'Supply both filter_variable and a nonblank filter_value, or omit both fields.',
    },
    {
      reason: 'search_offset_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The requested offset exceeds FRED’s search ceiling.',
      recovery: 'Use offset 4000 or lower. Narrow the search or add filters to reach more matches.',
    },
  ],

  input: z.object({
    query: z.string().min(1).describe('Search terms.'),
    search_type: z
      .enum(['full_text', 'series_id'])
      .optional()
      .describe('Search mode — full_text (default) or series_id.'),
    filter_variable: z
      .enum(['frequency', 'units', 'seasonal_adjustment'])
      .optional()
      .describe('Post-search filter dimension; requires a nonblank filter_value.'),
    filter_value: z
      .string()
      .optional()
      .describe(
        'Nonblank value for filter_variable. Frequency and seasonal adjustment labels are normalized. Units must match FRED’s spelling and case exactly. Supply both filter fields or neither.',
      ),
    tag_names: z
      .string()
      .optional()
      .describe('Semicolon-delimited list of tag names to filter by.'),
    limit: z.number().int().min(1).max(1000).optional().describe('Max results (default 20).'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(4999)
      .optional()
      .describe(
        'FRED accepts offsets through 4000 and exposes only the first 5000 matches. For the final page, start at 4000 and use limit 1000.',
      ),
  }),

  /** FRED's own `/series/search` parameter for the query is `search_text`. */
  inputAliases: { search_text: 'query' },

  output: z.object({
    count: z.number().describe('Total matching series count.'),
    offset: z.number().describe('Pagination offset applied.'),
    limit: z.number().describe('Limit applied.'),
    query: z.string().describe('Search query that was executed.'),
    active_filters: z
      .record(z.string(), z.string())
      .optional()
      .describe('Active filter dimensions and values, if any were applied.'),
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

  enrichment: {
    totalCount: z.number().describe('Total matching series count before pagination was applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance for empty pages or matches beyond FRED’s search window.'),
  },

  async handler(input, ctx) {
    ctx.log.info('fedreserve_search_series', { query: input.query });
    if (input.offset !== undefined && input.offset > MAX_SEARCH_OFFSET) {
      throw ctx.fail(
        'search_offset_exceeded',
        `FRED accepts search offsets through ${MAX_SEARCH_OFFSET}.`,
      );
    }

    const filterVariable = input.filter_variable;
    let filterValue = input.filter_value?.trim();
    if (filterVariable !== undefined || filterValue !== undefined) {
      if (filterVariable === undefined) {
        throw ctx.fail(
          'invalid_filter',
          'filter_variable is missing; supply it together with a nonblank filter_value.',
        );
      }
      if (!filterValue) {
        throw ctx.fail(
          'invalid_filter',
          'filter_value is missing or blank; supply a nonblank value together with filter_variable.',
        );
      }
      if (filterVariable === 'frequency') {
        const comma = filterValue.indexOf(',');
        const base = comma < 0 ? filterValue : filterValue.slice(0, comma).trimEnd();
        filterValue = FREQUENCIES.get(base.toLowerCase()) ?? filterValue;
      } else if (filterVariable === 'seasonal_adjustment') {
        filterValue = SEASONAL_ADJUSTMENTS.get(filterValue.toLowerCase()) ?? filterValue;
      }
    }
    const resp = await getFredApiService().searchSeries(
      {
        query: input.query,
        ...(input.search_type && { search_type: input.search_type }),
        ...(filterVariable !== undefined && { filter_variable: filterVariable }),
        ...(filterValue !== undefined && { filter_value: filterValue }),
        ...(input.tag_names && { tag_names: input.tag_names }),
        limit: input.limit ?? DEFAULT_LIMIT,
        ...(input.offset !== undefined && { offset: input.offset }),
      },
      ctx,
    );
    ctx.enrich.total(resp.count);

    const activeFilters: Record<string, string> = {};
    if (filterVariable !== undefined && filterValue !== undefined) {
      activeFilters[filterVariable] = filterValue;
    }
    if (input.tag_names) activeFilters.tag_names = input.tag_names;

    const series = resp.seriess ?? [];
    const notices: string[] = [];
    if (series.length === 0) {
      if (resp.count > 0) {
        notices.push(`No series on this page. Try a lower offset than ${resp.offset}.`);
      } else {
        notices.push(
          filterVariable === undefined
            ? 'Try broadening the search term or using fedreserve_browse_categories to explore available series.'
            : 'FRED filters match exact values after normalization. Try another filter value, remove the filter, or broaden the search.',
        );
      }
    }
    if (resp.count > SEARCH_WINDOW) {
      notices.push(
        `FRED exposes only the first ${SEARCH_WINDOW} matches. For the final page use offset ${MAX_SEARCH_OFFSET} and limit 1000. To reach more matches, narrow the search or add filters.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      count: resp.count,
      offset: resp.offset,
      limit: resp.limit,
      query: input.query,
      ...(Object.keys(activeFilters).length > 0 && { active_filters: activeFilters }),
      series: series.map((s) => ({
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
    const filterSummary =
      result.active_filters && Object.keys(result.active_filters).length > 0
        ? ` | Filters: ${Object.entries(result.active_filters)
            .map(([k, v]) => `${escapeMarkdownInline(k)}=${escapeMarkdownInline(v)}`)
            .join(', ')}`
        : '';
    const lines = [
      `**Query:** "${escapeMarkdownInline(result.query)}" — ${result.count} total match(es), showing ${result.series.length} (offset ${result.offset}, limit ${result.limit})${filterSummary}\n`,
    ];
    if (result.count === 0) lines.push('No series found.');
    for (const s of result.series) {
      const title = `${escapeMarkdownInline(s.id)}: ${escapeMarkdownInline(s.title)}`;
      lines.push(title.includes('\n') ? title : `### ${title}`);
      lines.push(
        `**Units:** ${escapeMarkdownInline(s.units)} | **Frequency:** ${escapeMarkdownInline(s.frequency)} | **Seasonal adj.:** ${escapeMarkdownInline(s.seasonal_adjustment)}`,
      );
      lines.push(
        `**Last updated:** ${escapeMarkdownInline(s.last_updated)}${s.popularity !== undefined ? ` | **Popularity:** ${s.popularity}` : ''}`,
      );
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

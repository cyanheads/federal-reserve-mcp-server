/**
 * @fileoverview Navigate the FRED category tree. Returns child categories and
 * a paginated series list when viewing a leaf. Omit category_id to start at the
 * root (ID 0).
 * @module mcp-server/tools/definitions/fedreserve-browse-categories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { FredDomainError } from '@/services/fred/fred-error.js';
import { getFredApiService } from '@/services/fred/fred-service.js';

const DEFAULT_SERIES_LIMIT = 10;

export const fedreserveBrowseCategoriesTool = tool('fedreserve_browse_categories', {
  title: 'Browse FRED Categories',
  description:
    'Navigate the FRED category tree. Returns the current category and its child categories. A leaf category returns a paginated list of its series in descending popularity order. Omit category_id to start at the root (ID 0).',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'category_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'category_id does not exist on FRED.',
      recovery: 'Omit category_id to start at the root, or navigate from a known parent ID.',
    },
  ],

  input: z.object({
    category_id: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Category ID to view. Omit or use 0 to start at the root.'),
    series_limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Maximum series on a leaf category page (default 10).'),
    series_offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Offset for the series page of a leaf category (default 0).'),
  }),

  output: z.object({
    category: z
      .object({
        id: z.number().describe('Category ID.'),
        name: z.string().describe('Category name.'),
        parent_id: z.number().optional().describe('Parent category ID when applicable.'),
        notes: z.string().optional().describe('Category notes when provided.'),
      })
      .describe('The category being viewed.'),
    children: z
      .array(
        z
          .object({
            id: z.number().describe('Child category ID.'),
            name: z.string().describe('Child category name.'),
          })
          .describe('A child category in the FRED hierarchy.'),
      )
      .describe('Child categories. Empty for leaf nodes.'),
    sample_series: z
      .array(
        z
          .object({
            id: z.string().describe('Series ID.'),
            title: z.string().describe('Series title.'),
            units: z.string().describe('Units of measurement.'),
            frequency: z.string().describe('Data frequency.'),
          })
          .describe('One series in this leaf category.'),
      )
      .optional()
      .describe('Page of series ordered by descending popularity. Returned for leaf categories.'),
    series_count: z
      .number()
      .optional()
      .describe('Total series in a leaf category before pagination.'),
  }),

  enrichment: {
    totalCount: z.number().optional().describe('Total series count when browsing a leaf category.'),
  },

  handler(input, ctx) {
    const category_id = input.category_id ?? 0;
    ctx.log.info('fedreserve_browse_categories', { category_id });

    // The hierarchy and series page share one clock; only the service retries.
    return withRetry(
      async ({ signal }) => {
        const fred = getFredApiService();
        const fredContext = { ...ctx, signal };
        try {
          const [categoryResp, childrenResp] = await Promise.all([
            fred.getCategory(category_id, fredContext),
            fred.getCategoryChildren(category_id, fredContext),
          ]);
          const cat = categoryResp.categories?.[0];
          if (!cat) {
            throw ctx.fail('category_not_found', `Category ${category_id} not found on FRED.`);
          }
          const result = {
            category: {
              id: cat.id,
              name: cat.name,
              ...(cat.parent_id !== undefined && { parent_id: cat.parent_id }),
              ...(cat.notes?.trim() && { notes: cat.notes.trim() }),
            },
            children: (childrenResp.categories ?? []).map((c) => ({ id: c.id, name: c.name })),
          };
          if (result.children.length > 0) return result;

          const seriesResp = await fred.getCategorySeries(
            {
              category_id,
              limit: input.series_limit ?? DEFAULT_SERIES_LIMIT,
              offset: input.series_offset ?? 0,
            },
            fredContext,
          );
          signal.throwIfAborted();
          ctx.enrich.total(seriesResp.count);
          return {
            ...result,
            series_count: seriesResp.count,
            sample_series: (seriesResp.seriess ?? []).map((s) => ({
              id: s.id,
              title: s.title ?? '',
              units: s.units ?? '',
              frequency: s.frequency ?? '',
            })),
          };
        } catch (err) {
          signal.throwIfAborted();
          if (err instanceof FredDomainError && err.reason === 'category_not_found') {
            throw ctx.fail('category_not_found', err.message, undefined, { cause: err });
          }
          throw err;
        }
      },
      {
        operation: 'FRED category lookup',
        signal: ctx.signal,
        deadlineMs: 50_000,
        maxRetries: 0,
        isTransient: () => false,
      },
    );
  },

  format: (result) => {
    const lines: string[] = [];
    const title = `${escapeMarkdownInline(result.category.name)} (ID: ${result.category.id})`;
    lines.push(title.includes('\n') ? title : `## ${title}`);
    if (result.category.parent_id !== undefined) {
      lines.push(`Parent ID: ${result.category.parent_id}`);
    }
    if (result.category.notes) lines.push(`> ${escapeMarkdownInline(result.category.notes)}`);
    lines.push('');

    if (result.children.length > 0) {
      lines.push(`**${result.children.length} subcategories:**`);
      for (const c of result.children) {
        lines.push(`- [${c.id}] ${escapeMarkdownInline(c.name)}`);
      }
    } else {
      lines.push('_Leaf category — no subcategories._');
    }

    const series = result.sample_series ?? [];
    if (result.series_count !== undefined) {
      lines.push('', `**Series (${series.length} of ${result.series_count}):**`);
    }
    for (const s of series) {
      lines.push(
        `- **${escapeMarkdownInline(s.id)}**: ${escapeMarkdownInline(s.title)} (${escapeMarkdownInline(s.units)}, ${escapeMarkdownInline(s.frequency)})`,
      );
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

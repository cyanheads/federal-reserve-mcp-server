/**
 * @fileoverview Navigate the FRED category tree. Returns child categories and
 * a sample of series when viewing a leaf. Omit category_id to start at the
 * root (ID 0).
 * @module mcp-server/tools/definitions/fedreserve-browse-categories
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFredApiService } from '@/services/fred/fred-service.js';
import type { FredCategoryResponse } from '@/services/fred/types.js';

export const fedreserveBrowseCategoriesTool = tool('fedreserve_browse_categories', {
  title: 'Browse FRED Categories',
  description:
    'Navigate the FRED category tree. Returns the current category, its child categories, and — when viewing a leaf node with no children — a sample of series within it. Omit category_id to start at the root (ID 0).',
  annotations: { readOnlyHint: true, openWorldHint: false },

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
      .describe(
        'Sample series when the category has no children (leaf node). Use fedreserve_search_series or fedreserve_get_observations for deeper access.',
      ),
  }),

  async handler(input, ctx) {
    const category_id = input.category_id ?? 0;
    ctx.log.info('fedreserve_browse_categories', { category_id });

    let categoryResp: FredCategoryResponse;
    let childrenResp: FredCategoryResponse;
    try {
      [categoryResp, childrenResp] = await Promise.all([
        getFredApiService().getCategory(category_id, ctx),
        getFredApiService().getCategoryChildren(category_id, ctx),
      ]);
    } catch (err) {
      const fredBody = String(
        (err != null && typeof err === 'object' && 'data' in err
          ? (err as { data?: { body?: unknown } }).data?.body
          : undefined) ?? '',
      ).toLowerCase();
      if (
        fredBody.includes('does not exist') ||
        fredBody.includes('bad request') ||
        fredBody.includes('not found')
      ) {
        throw ctx.fail('category_not_found', `Category ${category_id} not found on FRED.`, {
          ...ctx.recoveryFor('category_not_found'),
        });
      }
      throw err;
    }

    const cat = categoryResp.categories?.[0];
    if (!cat) {
      throw ctx.fail('category_not_found', `Category ${category_id} not found on FRED.`, {
        ...ctx.recoveryFor('category_not_found'),
      });
    }

    const children = (childrenResp.categories ?? []).map((c) => ({ id: c.id, name: c.name }));

    let sample_series:
      | { id: string; title: string; units: string; frequency: string }[]
      | undefined;
    if (children.length === 0) {
      // Leaf node — fetch a sample of its series
      const seriesResp = await getFredApiService().getCategorySeries(
        { category_id, limit: 10 },
        ctx,
      );
      const seriess = seriesResp.seriess ?? [];
      if (seriess.length > 0) {
        sample_series = seriess.map((s) => ({
          id: s.id,
          title: s.title ?? '',
          units: s.units ?? '',
          frequency: s.frequency ?? '',
        }));
      }
    }

    return {
      category: {
        id: cat.id,
        name: cat.name,
        ...(cat.parent_id !== undefined && { parent_id: cat.parent_id }),
        ...(cat.notes?.trim() && { notes: cat.notes.trim() }),
      },
      children,
      ...(sample_series !== undefined && { sample_series }),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`## ${result.category.name} (ID: ${result.category.id})`);
    if (result.category.parent_id !== undefined) {
      lines.push(`Parent ID: ${result.category.parent_id}`);
    }
    if (result.category.notes) lines.push(`> ${result.category.notes}`);
    lines.push('');

    if (result.children.length > 0) {
      lines.push(`**${result.children.length} subcategories:**`);
      for (const c of result.children) {
        lines.push(`- [${c.id}] ${c.name}`);
      }
    } else {
      lines.push('_Leaf category — no subcategories._');
    }

    if (result.sample_series && result.sample_series.length > 0) {
      lines.push('');
      lines.push(`**Sample series (${result.sample_series.length}):**`);
      for (const s of result.sample_series) {
        lines.push(`- **${s.id}**: ${s.title} (${s.units}, ${s.frequency})`);
      }
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

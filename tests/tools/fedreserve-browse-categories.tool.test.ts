/**
 * @fileoverview Tests for the fedreserve_browse_categories tool.
 * @module tests/tools/fedreserve-browse-categories.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fedreserveBrowseCategoriesTool } from '@/mcp-server/tools/definitions/fedreserve-browse-categories.tool.js';

const mockGetCategory = vi.fn();
const mockGetCategoryChildren = vi.fn();
const mockGetCategorySeries = vi.fn();

vi.mock('@/services/fred/fred-service.js', () => ({
  getFredApiService: () => ({
    getCategory: mockGetCategory,
    getCategoryChildren: mockGetCategoryChildren,
    getCategorySeries: mockGetCategorySeries,
  }),
}));

describe('fedreserveBrowseCategoriesTool', () => {
  let ctx: HandlerContext<ReasonOf<typeof fedreserveBrowseCategoriesTool.errors>>;

  beforeEach(() => {
    ctx = createMockContext({ errors: fedreserveBrowseCategoriesTool.errors });
    mockGetCategory.mockReset();
    mockGetCategoryChildren.mockReset();
    mockGetCategorySeries.mockReset();
  });

  it('returns root category with children', async () => {
    mockGetCategory.mockResolvedValueOnce({
      categories: [{ id: 0, name: 'Categories', parent_id: undefined }],
    });
    mockGetCategoryChildren.mockResolvedValueOnce({
      categories: [
        { id: 32991, name: 'Money, Banking, & Finance' },
        { id: 10, name: 'Population, Employment, & Labor Markets' },
      ],
    });

    const input = fedreserveBrowseCategoriesTool.input.parse({});
    const result = await fedreserveBrowseCategoriesTool.handler(input, ctx);

    expect(result.category.id).toBe(0);
    expect(result.category.name).toBe('Categories');
    expect(result.children).toHaveLength(2);
    expect(result.children[0]?.id).toBe(32991);
    expect(result.sample_series).toBeUndefined();
  });

  it('fetches sample series for a leaf node (no children)', async () => {
    mockGetCategory.mockResolvedValueOnce({
      categories: [{ id: 32992, name: 'Interest Rates', parent_id: 32991 }],
    });
    mockGetCategoryChildren.mockResolvedValueOnce({ categories: [] });
    mockGetCategorySeries.mockResolvedValueOnce({
      seriess: [
        {
          id: 'FEDFUNDS',
          title: 'Effective Federal Funds Rate',
          units: 'Percent',
          frequency: 'Monthly',
        },
      ],
    });

    const input = fedreserveBrowseCategoriesTool.input.parse({ category_id: 32992 });
    const result = await fedreserveBrowseCategoriesTool.handler(input, ctx);

    expect(result.children).toHaveLength(0);
    expect(result.sample_series).toBeDefined();
    expect(result.sample_series).toHaveLength(1);
    expect(result.sample_series![0]?.id).toBe('FEDFUNDS');
  });

  it('throws when category not found', async () => {
    mockGetCategory.mockResolvedValueOnce({ categories: [] });
    mockGetCategoryChildren.mockResolvedValueOnce({ categories: [] });

    const input = fedreserveBrowseCategoriesTool.input.parse({ category_id: 99999 });
    await expect(fedreserveBrowseCategoriesTool.handler(input, ctx)).rejects.toThrow('not found');
  });

  it('format renders category name and children', () => {
    const output = {
      category: { id: 0, name: 'Categories' },
      children: [
        { id: 32991, name: 'Money, Banking, & Finance' },
        { id: 10, name: 'Population' },
      ],
    };
    const blocks = fedreserveBrowseCategoriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Categories');
    expect(text).toContain('Money, Banking, & Finance');
    expect(text).toContain('32991');
  });

  it('format renders sample series for leaf nodes', () => {
    const output = {
      category: { id: 32992, name: 'Interest Rates' },
      children: [],
      sample_series: [
        {
          id: 'FEDFUNDS',
          title: 'Effective Federal Funds Rate',
          units: 'Percent',
          frequency: 'Monthly',
        },
      ],
    };
    const blocks = fedreserveBrowseCategoriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('FEDFUNDS');
    expect(text).toContain('Effective Federal Funds Rate');
  });
});

/**
 * @fileoverview Tests for the fedreserve_browse_categories tool.
 * @module tests/tools/fedreserve-browse-categories.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fedreserveBrowseCategoriesTool } from '@/mcp-server/tools/definitions/fedreserve-browse-categories.tool.js';
import { FredDomainError } from '@/services/fred/fred-error.js';

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
    expect(mockGetCategorySeries).not.toHaveBeenCalled();

    mockGetCategory.mockResolvedValueOnce({
      categories: [{ id: 32991, name: 'Money, Banking, & Finance', parent_id: 0 }],
    });
    mockGetCategoryChildren.mockResolvedValueOnce({
      categories: [{ id: 32992, name: 'Interest Rates' }],
    });
    const child = await runToolContract(fedreserveBrowseCategoriesTool, {
      category_id: 32991,
      series_limit: 2,
      series_offset: 10,
    });
    expect(child.structuredContent).toMatchObject({
      category: { id: 32991, parent_id: 0 },
      children: [{ id: 32992 }],
    });
    expect(child.structuredContent).not.toHaveProperty('series_count');
    expect(child.structuredContent).not.toHaveProperty('totalCount');
    expect(mockGetCategorySeries).not.toHaveBeenCalled();
  });

  it('fetches sample series for a leaf node (no children)', async () => {
    mockGetCategory.mockResolvedValueOnce({
      categories: [{ id: 32992, name: 'Interest Rates', parent_id: 32991 }],
    });
    mockGetCategoryChildren.mockResolvedValueOnce({ categories: [] });
    mockGetCategorySeries.mockResolvedValueOnce({
      count: 1,
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
    expect(result.series_count).toBe(1);
    expect(mockGetCategorySeries).toHaveBeenCalledWith(
      { category_id: 32992, limit: 10, offset: 0 },
      expect.objectContaining({ requestId: ctx.requestId, signal: expect.any(AbortSignal) }),
    );
  });

  it('throws when category not found', async () => {
    mockGetCategory.mockResolvedValueOnce({ categories: [] });
    mockGetCategoryChildren.mockResolvedValueOnce({ categories: [] });

    const input = fedreserveBrowseCategoriesTool.input.parse({ category_id: 99999 });
    await expect(fedreserveBrowseCategoriesTool.handler(input, ctx)).rejects.toThrow('not found');
  });

  it('pages leaf series while keeping the upstream count beyond the last page', async () => {
    const category = { id: 32447, name: 'Unemployment Rate', parent_id: 10 };
    for (const [offset, series] of [
      [0, { id: 'UNRATE', title: 'Unemployment Rate', units: 'Percent', frequency: 'Monthly' }],
      [1, { id: 'UNRATENSA', title: 'Unemployment Rate', units: 'Percent', frequency: 'Monthly' }],
      [2, undefined],
    ] as const) {
      mockGetCategory.mockResolvedValueOnce({ categories: [category] });
      mockGetCategoryChildren.mockResolvedValueOnce({ categories: [] });
      mockGetCategorySeries.mockResolvedValueOnce({
        count: 2,
        limit: 1000,
        offset,
        seriess: series ? [series] : [],
      });
      const result = await runToolContract(fedreserveBrowseCategoriesTool, {
        category_id: category.id,
        series_limit: 1000,
        series_offset: offset,
      });
      expect(mockGetCategorySeries).toHaveBeenLastCalledWith(
        { category_id: category.id, limit: 1000, offset },
        expect.anything(),
      );
      expect(result.structuredContent).toMatchObject({
        series_count: 2,
        totalCount: 2,
        sample_series: series ? [series] : [],
      });
      expect(JSON.stringify(result.content)).toContain('of 2');
      if (series) expect(JSON.stringify(result.content)).toContain(series.id);
    }
  });

  it.each([{ series_limit: 1001 }, { series_offset: -1 }])(
    'rejects invalid paging without fetching: %j',
    async (input) => {
      const result = await runToolContract(fedreserveBrowseCategoriesTool, {
        category_id: 32447,
        ...input,
      });
      expect(result.isError).toBe(true);
      expect(mockGetCategory).not.toHaveBeenCalled();
      expect(mockGetCategoryChildren).not.toHaveBeenCalled();
      expect(mockGetCategorySeries).not.toHaveBeenCalled();
    },
  );

  it('preserves a non-entity validation error from the children request', async () => {
    mockGetCategory.mockResolvedValueOnce({ categories: [{ id: 0, name: 'Categories' }] });
    mockGetCategoryChildren.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ValidationError, 'Invalid category parameter.', {
        body: 'Bad Request. Invalid value for variable category_id.',
      }),
    );
    const result = await runToolContract(fedreserveBrowseCategoriesTool, {});
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, message: 'Invalid category parameter.' },
    });
    expect(JSON.stringify(result.content)).toContain('Invalid category parameter.');
  });

  it('renders the safe FRED message and recovery when a category is missing', async () => {
    mockGetCategory.mockRejectedValueOnce(
      new FredDomainError('category_not_found', 'The category does not exist.'),
    );
    mockGetCategoryChildren.mockResolvedValueOnce({ categories: [] });
    const result = await runToolContract(fedreserveBrowseCategoriesTool, { category_id: 99999 });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: 'The category does not exist.',
        data: {
          reason: 'category_not_found',
          recovery: { hint: expect.stringContaining('category_id') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('The category does not exist.');
    expect(JSON.stringify(result.content)).toContain('Recovery:');
    expect(mockGetCategorySeries).not.toHaveBeenCalled();
  });

  it('shares one deadline across the hierarchy and the leaf series request', async () => {
    vi.useFakeTimers();
    try {
      mockGetCategory.mockResolvedValueOnce({
        categories: [{ id: 32447, name: 'Unemployment Rate' }],
      });
      mockGetCategoryChildren.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ categories: [] }), 30_000)),
      );
      const seriesAborted = vi.fn();
      mockGetCategorySeries.mockImplementationOnce(
        (_params, { signal }: { signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const finish = setTimeout(() => resolve({ count: 0, seriess: [] }), 30_000);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(finish);
                seriesAborted();
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      );
      const result = runToolContract(fedreserveBrowseCategoriesTool, { category_id: 32447 });
      await vi.advanceTimersByTimeAsync(49_999);
      expect(mockGetCategorySeries).toHaveBeenCalledTimes(1);
      expect(seriesAborted).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTimersAsync();
      expect(seriesAborted).toHaveBeenCalledTimes(1);
      expect((await result).structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.Timeout },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
      series_count: 1,
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
    expect(text).toContain('1 of 1');
  });
});

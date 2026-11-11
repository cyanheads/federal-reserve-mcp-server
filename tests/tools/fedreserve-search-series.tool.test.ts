/**
 * @fileoverview Tests for the fedreserve_search_series tool.
 * @module tests/tools/fedreserve-search-series.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fedreserveSearchSeriesTool } from '@/mcp-server/tools/definitions/fedreserve-search-series.tool.js';

const mockSearchSeries = vi.fn();
const SEARCH_RESPONSE = {
  count: 2,
  offset: 0,
  limit: 1000,
  seriess: [
    {
      id: 'UNRATE',
      title: 'Unemployment Rate',
      units: 'Percent',
      frequency: 'Monthly',
      seasonal_adjustment: 'Seasonally Adjusted',
      last_updated: '2026-05-01',
      popularity: 95,
    },
    {
      id: 'U6RATE',
      title: 'Total Unemployed',
      units: 'Percent',
      frequency: 'Monthly',
      seasonal_adjustment: 'Seasonally Adjusted',
      last_updated: '2026-05-01',
      // popularity omitted — sparse upstream field
    },
  ],
};

vi.mock('@/services/fred/fred-service.js', () => ({
  getFredApiService: () => ({ searchSeries: mockSearchSeries }),
}));

describe('fedreserveSearchSeriesTool', () => {
  let ctx: HandlerContext<ReasonOf<typeof fedreserveSearchSeriesTool.errors>>;

  beforeEach(() => {
    ctx = createMockContext({ errors: fedreserveSearchSeriesTool.errors });
    mockSearchSeries.mockReset().mockResolvedValue(SEARCH_RESPONSE);
  });

  it('returns matching series with all required fields', async () => {
    const input = fedreserveSearchSeriesTool.input.parse({ query: 'unemployment' });
    const result = await fedreserveSearchSeriesTool.handler(input, ctx);

    expect(result.count).toBe(2);
    expect(result.series).toHaveLength(2);
    expect(result.series[0]).toMatchObject({
      id: 'UNRATE',
      title: 'Unemployment Rate',
      units: 'Percent',
      frequency: 'Monthly',
      popularity: 95,
    });
  });

  it('uses a 20-result default page', async () => {
    mockSearchSeries.mockResolvedValueOnce({ ...SEARCH_RESPONSE, limit: 20 });
    const result = await runToolContract(fedreserveSearchSeriesTool, { query: 'unemployment' });
    expect(mockSearchSeries).toHaveBeenCalledWith(
      { query: 'unemployment', limit: 20 },
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ limit: 20 });
    expect(JSON.stringify(result.content)).toContain('limit 20');
  });

  it('allows the last reachable page at maximum limit and discloses the search window', async () => {
    mockSearchSeries.mockResolvedValueOnce({
      ...SEARCH_RESPONSE,
      count: 5001,
      offset: 4000,
      seriess: Array.from({ length: 1000 }, (_, index) => ({
        id: `SERIES${4000 + index}`,
        title: `Series ${4000 + index}`,
      })),
    });
    const result = await runToolContract(fedreserveSearchSeriesTool, {
      query: 'unemployment',
      offset: 4000,
      limit: 1000,
    });
    expect(mockSearchSeries).toHaveBeenCalledWith(
      { query: 'unemployment', offset: 4000, limit: 1000 },
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      count: 5001,
      notice: expect.stringContaining('4000'),
    });
    const page = fedreserveSearchSeriesTool.output.parse(result.structuredContent);
    expect(page.series).toHaveLength(1000);
    expect(JSON.stringify(result.content)).toContain('4000');
    expect(JSON.stringify(result.content)).toContain('SERIES4999');
    expect(JSON.stringify(result.content)).toContain('narrow');
  });

  it.each([4001, 4999])('rejects unreachable offset %i before fetching', async (offset) => {
    const result = await runToolContract(fedreserveSearchSeriesTool, {
      query: 'unemployment',
      offset,
      limit: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'search_offset_exceeded',
          recovery: { hint: expect.stringContaining('4000') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('Recovery:');
    expect(mockSearchSeries).not.toHaveBeenCalled();
  });

  it.each([
    ['frequency', 'quarterly', 'Quarterly'],
    ['frequency', 'QUARTERLY', 'Quarterly'],
    ['frequency', '  Quarterly  ', 'Quarterly'],
    ['frequency', '  Monthly  ', 'Monthly'],
    ['frequency', 'Quarterly, End of Period', 'Quarterly'],
    ['frequency', 'Weekly, Ending Saturday', 'Weekly'],
    ['frequency', ' future frequency ', 'future frequency'],
    ['seasonal_adjustment', 'not seasonally adjusted', 'Not Seasonally Adjusted'],
    ['units', ' Percent ', 'Percent'],
    ['units', 'percent', 'percent'],
  ] as const)(
    'normalizes %s %j to %j and echoes the sent value',
    async (filter_variable, filter_value, expected) => {
      const result = await runToolContract(fedreserveSearchSeriesTool, {
        query: 'unemployment',
        filter_variable,
        filter_value,
        limit: 1,
      });
      expect(mockSearchSeries).toHaveBeenCalledWith(
        { query: 'unemployment', filter_variable, filter_value: expected, limit: 1 },
        expect.anything(),
      );
      expect(result.structuredContent).toMatchObject({
        active_filters: { [filter_variable]: expected },
      });
      expect(JSON.stringify(result.content)).toContain(`${filter_variable}=${expected}`);
    },
  );

  it.each([
    { count: 0, offset: 0, guidance: 'exact' },
    { count: 77, offset: 100, guidance: 'lower offset' },
    { count: 5001, offset: 4000, guidance: 'lower offset' },
  ])(
    'provides the relevant empty page notice on both surfaces: %j',
    async ({ count, offset, guidance }) => {
      mockSearchSeries.mockResolvedValueOnce({ count, offset, limit: 1, seriess: [] });
      const result = await runToolContract(fedreserveSearchSeriesTool, {
        query: 'unemployment',
        filter_variable: 'units',
        filter_value: 'Percent',
        limit: 1,
        offset,
      });
      expect(result.structuredContent).toMatchObject({ notice: expect.stringContaining(guidance) });
      expect(JSON.stringify(result.content)).toContain(guidance);
      if (count > 5000) {
        expect(result.structuredContent).toMatchObject({ notice: expect.stringContaining('5000') });
      }
    },
  );

  it.each(['Monthly', 'Annual'])('preserves the canonical filter value %s', async (value) => {
    const result = await runToolContract(fedreserveSearchSeriesTool, {
      query: 'unemployment',
      filter_variable: 'frequency',
      filter_value: value,
    });
    expect(result.isError).toBeFalsy();
    expect(mockSearchSeries).toHaveBeenCalledWith(
      { query: 'unemployment', filter_variable: 'frequency', filter_value: value, limit: 20 },
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({ active_filters: { frequency: value } });
    expect(JSON.stringify(result.content)).toContain(`frequency=${value}`);
  });

  it.each([
    { count: 77, offset: 1, returned: true },
    { count: 0, offset: 0, returned: false },
    { count: 77, offset: 100, returned: false },
  ])('renders the upstream total in final enrichment: %j', async ({ count, offset, returned }) => {
    mockSearchSeries.mockResolvedValueOnce({
      ...SEARCH_RESPONSE,
      count,
      offset,
      limit: 1,
      seriess: returned ? SEARCH_RESPONSE.seriess.slice(0, 1) : [],
    });
    const result = await runToolContract(fedreserveSearchSeriesTool, {
      query: 'unemployment',
      limit: 1,
      offset,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ count, totalCount: count, offset });
    if (count === 0) {
      expect(result.structuredContent).toMatchObject({
        notice: expect.stringContaining('Try broadening'),
      });
      expect(JSON.stringify(result.content)).toContain('Try broadening');
    }
    expect(result.content.at(-1)).toMatchObject({
      text: expect.stringContaining(`${count} total`),
    });
    expect(mockSearchSeries).toHaveBeenCalledWith(
      { query: 'unemployment', limit: 1, offset },
      expect.anything(),
    );
  });

  it.each([
    { filter_variable: 'frequency' },
    { filter_value: 'Monthly' },
    { filter_variable: 'frequency', filter_value: '' },
    { filter_variable: 'frequency', filter_value: '   ' },
    { filter_value: '' },
    { filter_value: '\t\n' },
  ])('rejects an incomplete or blank filter pair before fetching: %j', async (filter) => {
    const result = await runToolContract(fedreserveSearchSeriesTool, {
      query: 'unemployment',
      ...filter,
    } as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_filter',
          recovery: { hint: expect.stringContaining('filter_variable') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('filter_value');
    expect(JSON.stringify(result.content)).toContain('Recovery:');
    expect(mockSearchSeries).not.toHaveBeenCalled();
  });

  it('preserves optional popularity field from sparse upstream', async () => {
    const input = fedreserveSearchSeriesTool.input.parse({ query: 'unemployment' });
    const result = await fedreserveSearchSeriesTool.handler(input, ctx);

    // U6RATE has no popularity in the fixture
    expect(result.series[1]?.popularity).toBeUndefined();
    // UNRATE has popularity
    expect(result.series[0]?.popularity).toBe(95);
  });

  it('format renders all series fields', () => {
    const output = {
      count: 1,
      offset: 0,
      limit: 1000,
      query: 'unemployment',
      series: [
        {
          id: 'UNRATE',
          title: 'Unemployment Rate',
          units: 'Percent',
          frequency: 'Monthly',
          seasonal_adjustment: 'Seasonally Adjusted',
          last_updated: '2026-05-01',
          popularity: 95,
        },
      ],
    };
    const blocks = fedreserveSearchSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('UNRATE');
    expect(text).toContain('Unemployment Rate');
    expect(text).toContain('Percent');
    expect(text).toContain('Monthly');
    expect(text).toContain('2026-05-01');
    expect(text).toContain('95');
  });

  it('format shows empty message when no results', () => {
    const blocks = fedreserveSearchSeriesTool.format!({
      count: 0,
      offset: 0,
      limit: 1000,
      query: 'unemployment',
      series: [],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No series found');
  });

  /**
   * The alias rewrite runs inside `parseToolArguments`, so it is only reachable
   * through the contract boundary — a direct `handler()` call skips it.
   */
  it('accepts FRED’s search_text under the declared query', async () => {
    const result = await runToolContract(fedreserveSearchSeriesTool, {
      search_text: 'unemployment',
    } as never);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ query: 'unemployment', count: 2 });
    expect(JSON.stringify(result.content)).toContain('UNRATE');
  });
});

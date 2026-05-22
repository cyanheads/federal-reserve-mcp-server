/**
 * @fileoverview Tests for the fred_search_series tool.
 * @module tests/tools/fred-search-series.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fredSearchSeriesTool } from '@/mcp-server/tools/definitions/fred-search-series.tool.js';

vi.mock('@/services/fred/fred-service.js', () => ({
  getFredApiService: () => ({
    searchSeries: vi.fn().mockResolvedValue({
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
    }),
  }),
}));

describe('fredSearchSeriesTool', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('returns matching series with all required fields', async () => {
    const input = fredSearchSeriesTool.input.parse({ query: 'unemployment' });
    const result = await fredSearchSeriesTool.handler(input, ctx);

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

  it('preserves optional popularity field from sparse upstream', async () => {
    const input = fredSearchSeriesTool.input.parse({ query: 'unemployment' });
    const result = await fredSearchSeriesTool.handler(input, ctx);

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
    const blocks = fredSearchSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('UNRATE');
    expect(text).toContain('Unemployment Rate');
    expect(text).toContain('Percent');
    expect(text).toContain('Monthly');
    expect(text).toContain('2026-05-01');
    expect(text).toContain('95');
  });

  it('format shows empty message when no results', () => {
    const blocks = fredSearchSeriesTool.format!({
      count: 0,
      offset: 0,
      limit: 1000,
      series: [],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No series found');
  });
});

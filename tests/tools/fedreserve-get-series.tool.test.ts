/**
 * @fileoverview Tests for the fedreserve_get_series tool.
 * @module tests/tools/fedreserve-get-series.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fedreserveGetSeriesTool } from '@/mcp-server/tools/definitions/fedreserve-get-series.tool.js';

const mockGetSeriesById = vi.fn();

vi.mock('@/services/fred/fred-service.js', () => ({
  getFredApiService: () => ({
    getSeriesById: mockGetSeriesById,
  }),
}));

const UNRATE_RAW = {
  id: 'UNRATE',
  title: 'Unemployment Rate',
  units: 'Percent',
  frequency: 'Monthly',
  seasonal_adjustment: 'Seasonally Adjusted',
  last_updated: '2026-05-01',
  observation_start: '1948-01-01',
  observation_end: '2026-04-01',
  popularity: 95,
};

describe('fedreserveGetSeriesTool', () => {
  let ctx: HandlerContext<ReasonOf<typeof fedreserveGetSeriesTool.errors>>;

  beforeEach(() => {
    ctx = createMockContext({ errors: fedreserveGetSeriesTool.errors });
    mockGetSeriesById.mockReset();
  });

  it('returns metadata for a single series ID string', async () => {
    mockGetSeriesById.mockResolvedValueOnce({ seriess: [UNRATE_RAW] });

    const input = fedreserveGetSeriesTool.input.parse({ series_ids: 'UNRATE' });
    const result = await fedreserveGetSeriesTool.handler(input, ctx);

    expect(result.series).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.series[0]).toMatchObject({
      id: 'UNRATE',
      title: 'Unemployment Rate',
      units: 'Percent',
      frequency: 'Monthly',
      seasonal_adjustment: 'Seasonally Adjusted',
      last_updated: '2026-05-01',
      observation_start: '1948-01-01',
      observation_end: '2026-04-01',
      popularity: 95,
    });
  });

  it('returns partial success for a batch with one failure', async () => {
    mockGetSeriesById
      .mockResolvedValueOnce({ seriess: [UNRATE_RAW] })
      .mockRejectedValueOnce(new Error('Network timeout'));

    const input = fedreserveGetSeriesTool.input.parse({ series_ids: ['UNRATE', 'BOGUS'] });
    const result = await fedreserveGetSeriesTool.handler(input, ctx);

    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.id).toBe('UNRATE');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.id).toBe('BOGUS');
    expect(result.failed[0]?.error).toContain('Network timeout');
  });

  it('throws series_not_found for a single series that returns empty seriess', async () => {
    mockGetSeriesById.mockResolvedValueOnce({ seriess: [] });

    const input = fedreserveGetSeriesTool.input.parse({ series_ids: 'DOESNOTEXIST' });
    await expect(fedreserveGetSeriesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'series_not_found' },
    });
  });

  it('throws partial_failure when all IDs fail', async () => {
    mockGetSeriesById
      .mockRejectedValueOnce(new Error('404'))
      .mockRejectedValueOnce(new Error('404'));

    const input = fedreserveGetSeriesTool.input.parse({ series_ids: ['BAD1', 'BAD2'] });
    await expect(fedreserveGetSeriesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'partial_failure' },
    });
  });

  it('omits optional fields absent from sparse upstream payload', async () => {
    const sparse = { id: 'SPARSE', title: 'Sparse Series' };
    mockGetSeriesById.mockResolvedValueOnce({ seriess: [sparse] });

    const input = fedreserveGetSeriesTool.input.parse({ series_ids: 'SPARSE' });
    const result = await fedreserveGetSeriesTool.handler(input, ctx);

    expect(result.series[0]?.popularity).toBeUndefined();
    expect(result.series[0]?.notes).toBeUndefined();
    expect(result.series[0]?.observation_start).toBeUndefined();
  });

  it('format renders series ID, title, and units', () => {
    const output = {
      series: [
        {
          id: 'UNRATE',
          title: 'Unemployment Rate',
          units: 'Percent',
          frequency: 'Monthly',
          seasonal_adjustment: 'Seasonally Adjusted',
          last_updated: '2026-05-01',
        },
      ],
      failed: [],
    };
    const blocks = fedreserveGetSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('UNRATE');
    expect(text).toContain('Unemployment Rate');
    expect(text).toContain('Percent');
    expect(text).toContain('Monthly');
  });

  it('format renders failed entries', () => {
    const output = {
      series: [],
      failed: [{ id: 'BOGUS', error: 'not found' }],
    };
    const blocks = fedreserveGetSeriesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('BOGUS');
    expect(text).toContain('not found');
  });
});

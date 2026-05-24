/**
 * @fileoverview Tests for the fedreserve_get_observations tool.
 * @module tests/tools/fedreserve-get-observations.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fedreserveGetObservationsTool } from '@/mcp-server/tools/definitions/fedreserve-get-observations.tool.js';

const mockGetObservations = vi.fn();

vi.mock('@/services/fred/fred-service.js', () => ({
  getFredApiService: () => ({
    getObservations: mockGetObservations,
  }),
}));

// Canvas bridge absent by default — tests the no-canvas path
vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: () => undefined,
}));

const UNRATE_OBS = {
  observation_start: '2020-01-01',
  observation_end: '2020-03-01',
  units: 'Percent',
  observations: [
    { date: '2020-01-01', value: '3.5' },
    { date: '2020-02-01', value: '3.5' },
    { date: '2020-03-01', value: '4.4' },
  ],
};

describe('fedreserveGetObservationsTool', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext({ errors: fedreserveGetObservationsTool.errors });
    mockGetObservations.mockReset();
  });

  it('returns inline observations for a single short series', async () => {
    mockGetObservations.mockResolvedValueOnce(UNRATE_OBS);

    const input = fedreserveGetObservationsTool.input.parse({ series_ids: 'UNRATE' });
    const result = await fedreserveGetObservationsTool.handler(input, ctx);

    expect(result.series).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.dataset).toBeUndefined();
    expect(result.series[0]?.series_id).toBe('UNRATE');
    expect(result.series[0]?.observation_count).toBe(3);
    expect(result.series[0]?.observations[0]?.value).toBe('3.5');
    expect(result.total_observations).toBe(3);
  });

  it('preserves observation values as strings (no float coercion)', async () => {
    mockGetObservations.mockResolvedValueOnce({
      ...UNRATE_OBS,
      observations: [{ date: '2020-01-01', value: '3.50' }],
    });

    const input = fedreserveGetObservationsTool.input.parse({ series_ids: 'UNRATE' });
    const result = await fedreserveGetObservationsTool.handler(input, ctx);

    expect(typeof result.series[0]?.observations[0]?.value).toBe('string');
    expect(result.series[0]?.observations[0]?.value).toBe('3.50');
  });

  it('throws series_not_found when single series returns no observations and message includes not found', async () => {
    mockGetObservations.mockRejectedValueOnce(new Error('404 not found'));

    const input = fedreserveGetObservationsTool.input.parse({ series_ids: 'MISSING' });
    await expect(fedreserveGetObservationsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'series_not_found' },
    });
  });

  it('throws no_observations_in_range for single series with empty observations', async () => {
    mockGetObservations.mockResolvedValueOnce({ ...UNRATE_OBS, observations: [] });

    const input = fedreserveGetObservationsTool.input.parse({ series_ids: 'UNRATE' });
    await expect(fedreserveGetObservationsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_observations_in_range' },
    });
  });

  it('shows canvas-unavailable message when multi-series and no bridge', async () => {
    mockGetObservations.mockResolvedValueOnce(UNRATE_OBS).mockResolvedValueOnce({
      ...UNRATE_OBS,
      observations: [{ date: '2020-01-01', value: '2.1' }],
    });

    const input = fedreserveGetObservationsTool.input.parse({ series_ids: ['UNRATE', 'FEDFUNDS'] });
    const result = await fedreserveGetObservationsTool.handler(input, ctx);

    expect(result.dataset).toBeUndefined();
    expect(result.message).toBeDefined();
    expect(result.message).toContain('CANVAS_PROVIDER_TYPE');
  });

  it('adds failed entry for one bad series in a multi-series batch', async () => {
    mockGetObservations
      .mockResolvedValueOnce(UNRATE_OBS)
      .mockRejectedValueOnce(new Error('timeout'));

    const input = fedreserveGetObservationsTool.input.parse({ series_ids: ['UNRATE', 'BAD'] });
    const result = await fedreserveGetObservationsTool.handler(input, ctx);

    expect(result.series).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.series_id).toBe('BAD');
  });

  it('format renders series ID, units, and observation table', () => {
    const output = {
      series: [
        {
          series_id: 'UNRATE',
          observation_start: '2020-01-01',
          observation_end: '2020-03-01',
          units: 'Percent',
          observation_count: 2,
          observations: [
            { date: '2020-01-01', value: '3.5' },
            { date: '2020-02-01', value: '3.5' },
          ],
        },
      ],
      failed: [],
      total_observations: 2,
    };
    const blocks = fedreserveGetObservationsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('UNRATE');
    expect(text).toContain('Percent');
    expect(text).toContain('2020-01-01');
    expect(text).toContain('3.5');
  });

  it('format includes canvas dataset name when spilled', () => {
    const output = {
      series: [],
      failed: [],
      total_observations: 600,
      dataset: {
        name: 'df_ABC12_DEF34',
        row_count: 600,
        expires_at: '2026-05-22T00:00:00.000Z',
        preview_rows: 20,
        truncated: false,
      },
    };
    const blocks = fedreserveGetObservationsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_ABC12_DEF34');
  });
});

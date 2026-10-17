/**
 * @fileoverview Tests for the fedreserve_get_observations tool.
 * @module tests/tools/fedreserve-get-observations.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  let ctx: HandlerContext<ReasonOf<typeof fedreserveGetObservationsTool.errors>>;

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

  it.each([
    ['series_not_found', 'The series does not exist'],
    ['frequency_too_high', 'The frequency cannot be higher than the native frequency'],
  ])('preserves the %s classification and recovery from the FRED body', async (reason, body) => {
    mockGetObservations.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ValidationError, 'FRED returned HTTP 400 Bad Request.', {
        body,
      }),
    );
    const result = await runToolContract(fedreserveGetObservationsTool, { series_ids: 'UNRATE' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason, recovery: { hint: expect.any(String) } } },
    });
    expect(JSON.stringify(result.content)).toContain('Recovery:');
    expect(JSON.stringify(result.content)).toContain(reason);
  });

  it('preserves supplied observation dates and rejects malformed dates', () => {
    const dated = {
      series_ids: 'UNRATE',
      observation_start: '2020-01-01',
      observation_end: '2020-03-01',
    };
    expect(fedreserveGetObservationsTool.input.parse(dated)).toMatchObject(dated);
    for (const field of ['observation_start', 'observation_end']) {
      expect(
        fedreserveGetObservationsTool.input.safeParse({ ...dated, [field]: '01/01/2020' }).success,
      ).toBe(false);
    }
  });

  it('rejects the obsolete canvas_id input before fetching', async () => {
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'UNRATE',
      canvas_id: 'df_ABC12_DEF34',
    } as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(JSON.stringify(result.content)).toContain('canvas_id');
    expect(mockGetObservations).not.toHaveBeenCalled();
    expect(fedreserveGetObservationsTool.input.shape).not.toHaveProperty('canvas_id');
  });

  it.each(['observation_start', 'observation_end'])(
    'rejects impossible calendar dates in %s before fetching',
    async (field) => {
      for (const date of [
        '2024-13-01',
        '2024-00-10',
        '2024-01-00',
        '2024-04-31',
        '2024-02-30',
        '2023-02-29',
        '1900-02-29',
      ]) {
        const result = await runToolContract(fedreserveGetObservationsTool, {
          series_ids: 'UNRATE',
          [field]: date,
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
        expect(JSON.stringify(result.content)).toContain(field);
        expect(JSON.stringify(result.content)).toContain(date);
      }
      expect(mockGetObservations).not.toHaveBeenCalled();
    },
  );

  it.each(['2024-02-29', '2000-02-29'])('accepts the leap date %s unchanged', async (date) => {
    mockGetObservations.mockResolvedValueOnce(UNRATE_OBS);
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'UNRATE',
      observation_start: date,
      observation_end: date,
    });
    expect(result.isError).toBeFalsy();
    expect(mockGetObservations).toHaveBeenCalledWith(
      { series_id: 'UNRATE', observation_start: date, observation_end: date },
      expect.anything(),
    );
  });

  it('treats blank optional dates as unset without forwarding them to FRED', async () => {
    mockGetObservations.mockResolvedValueOnce(UNRATE_OBS);
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'UNRATE',
      observation_start: '',
      observation_end: '',
    });
    expect(result.isError).toBeFalsy();
    expect(mockGetObservations).toHaveBeenCalledWith({ series_id: 'UNRATE' }, expect.anything());
    expect(result.structuredContent).toMatchObject({
      series: [{ series_id: 'UNRATE', observation_count: 3 }],
    });
    expect(JSON.stringify(result.content)).toContain('2020-01-01');
    expect(JSON.stringify(result.content)).toContain('3.5');
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

  it.each([
    {},
    { observation_start: '2024-01-15' },
    { observation_end: '2024-03-31' },
    { observation_start: '2024-01-15', observation_end: '2024-03-31' },
  ])(
    'derives fetched bounds from all rows, independent of request bounds or order: %j',
    async (bounds) => {
      mockGetObservations.mockResolvedValueOnce({
        observation_start: bounds.observation_start ?? '1600-01-01',
        observation_end: bounds.observation_end ?? '9999-12-31',
        units: 'lin',
        observations: [
          { date: '2024-03-01', value: '1' },
          { date: '2024-02-01', value: '2' },
        ],
      });
      const result = await runToolContract(fedreserveGetObservationsTool, {
        series_ids: 'UNRATE',
        ...bounds,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        series: [
          { observation_start: '2024-02-01', observation_end: '2024-03-01', observation_count: 2 },
        ],
      });
      expect(JSON.stringify(result.content)).toContain('Range: 2024-02-01 → 2024-03-01');
      expect(mockGetObservations).toHaveBeenCalledTimes(1);
    },
  );

  it('retains full fetched bounds and counts after no-canvas preview slicing', async () => {
    const observations = Array.from({ length: 501 }, (_, index) => ({
      date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
      value: String(index),
    })).reverse();
    mockGetObservations.mockResolvedValueOnce({
      ...UNRATE_OBS,
      observation_start: '1600-01-01',
      observation_end: '9999-12-31',
      observations,
    });
    const result = await runToolContract(fedreserveGetObservationsTool, { series_ids: 'UNRATE' });
    const output = fedreserveGetObservationsTool.output.parse(result.structuredContent);
    expect(output.series[0]).toMatchObject({
      observation_start: '2020-01-01',
      observation_end: observations[0]!.date,
      observation_count: 501,
    });
    expect(output.series[0]?.observations).toHaveLength(20);
    expect(JSON.stringify(result.content)).toContain(
      `Range: 2020-01-01 → ${observations[0]!.date}`,
    );
    expect(mockGetObservations).toHaveBeenCalledTimes(1);
  });

  it('uses null bounds for a successful empty series without displaying a fabricated range', async () => {
    mockGetObservations
      .mockResolvedValueOnce({ ...UNRATE_OBS, observations: [] })
      .mockResolvedValueOnce(UNRATE_OBS);
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: ['EMPTY', 'UNRATE'],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      series: [
        {
          series_id: 'EMPTY',
          observation_start: null,
          observation_end: null,
          observation_count: 0,
        },
        {
          series_id: 'UNRATE',
          observation_start: '2020-01-01',
          observation_end: '2020-03-01',
          observation_count: 3,
        },
      ],
    });
    const text = String((result.content[0] as { text: string }).text);
    expect(text.split('### EMPTY')[1]?.split('### UNRATE')[0]).not.toContain('Range:');
    expect(text).not.toContain('null');
    expect(mockGetObservations).toHaveBeenCalledTimes(2);
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

  /**
   * The alias rewrite runs inside `parseToolArguments`, so it is only reachable
   * through the contract boundary — a direct `handler()` call skips it.
   */
  it('accepts FRED’s singular series_id under the declared series_ids', async () => {
    mockGetObservations.mockResolvedValueOnce(UNRATE_OBS);

    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_id: 'UNRATE',
    } as never);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      series: [{ series_id: 'UNRATE', observation_count: 3 }],
    });
  });
});

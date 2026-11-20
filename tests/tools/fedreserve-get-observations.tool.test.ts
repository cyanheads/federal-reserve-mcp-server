/**
 * @fileoverview Tests for the fedreserve_get_observations tool.
 * @module tests/tools/fedreserve-get-observations.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFedreserveGetObservationsTool,
  fedreserveGetObservationsTool,
} from '@/mcp-server/tools/definitions/fedreserve-get-observations.tool.js';
import { FredDomainError } from '@/services/fred/fred-error.js';

const mockGetObservations = vi.fn();
const mockGetSeriesById = vi.fn();
const mockGetCanvasBridge = vi.fn();

vi.mock('@/services/fred/fred-service.js', () => ({
  getFredApiService: () => ({
    getObservations: mockGetObservations,
    getSeriesById: mockGetSeriesById,
  }),
}));

// Canvas bridge absent by default — tests the no-canvas path
vi.mock(import('@/services/canvas-bridge/canvas-bridge.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  getCanvasBridge: () => mockGetCanvasBridge(),
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

const DAILY_ROWS = Array.from({ length: 550 }, (_, index) => ({
  date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
  value: String(index),
}));

describe('fedreserveGetObservationsTool', () => {
  let ctx: HandlerContext<ReasonOf<typeof fedreserveGetObservationsTool.errors>>;
  const registerDataframe = vi.fn();

  beforeEach(() => {
    ctx = createMockContext({ errors: fedreserveGetObservationsTool.errors });
    mockGetObservations.mockReset().mockRejectedValue(new Error('Unexpected observations request'));
    mockGetSeriesById.mockReset().mockResolvedValue({ seriess: [] });
    mockGetCanvasBridge.mockReset();
    registerDataframe.mockReset();
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
    ['series_not_found', 'The series does not exist.'],
    ['frequency_too_high', "Value of frequency is not one of: 'q', 'sa', 'a'."],
  ] as const)('preserves the %s classification and recovery from FRED', async (reason, message) => {
    mockGetObservations.mockRejectedValueOnce(new FredDomainError(reason, message));
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
      { series_id: 'UNRATE', observation_start: date, observation_end: date, limit: 20 },
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
    expect(mockGetObservations).toHaveBeenCalledWith(
      { series_id: 'UNRATE', limit: 20 },
      expect.anything(),
    );
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

  it.each(['asc', 'desc'] as const)(
    'stages the full omitted-limit fetch and previews the newest rows in %s order',
    async (sort_order) => {
      const observations = Array.from({ length: 501 }, (_, index) => ({
        date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
        value: String(index),
      }));
      const newest = observations.slice(-20);
      const registerDataframe = vi.fn().mockResolvedValue({
        tableName: 'df_ABC12_DEF34',
        rowCount: 501,
        expiresAt: '2026-05-22T00:00:00.000Z',
      });
      mockGetCanvasBridge.mockReturnValue({ registerDataframe });
      mockGetObservations.mockResolvedValueOnce({
        ...UNRATE_OBS,
        observation_start: '1600-01-01',
        observation_end: '9999-12-31',
        observations: sort_order === 'desc' ? observations.toReversed() : observations,
        count: 550,
      });
      const result = await runToolContract(fedreserveGetObservationsTool, {
        series_ids: 'UNRATE',
        sort_order,
      });
      const output = fedreserveGetObservationsTool.output.parse(result.structuredContent);
      expect(output.series[0]).toMatchObject({
        observation_start: '2020-01-01',
        observation_end: observations.at(-1)!.date,
        observation_count: 501,
      });
      expect(output.series[0]?.observations).toEqual(
        sort_order === 'desc' ? newest.toReversed() : newest,
      );
      expect(output.dataset).toMatchObject({ row_count: 501, preview_rows: 20 });
      expect(mockGetObservations).toHaveBeenCalledWith(
        { series_id: 'UNRATE', sort_order },
        expect.anything(),
      );
      expect(registerDataframe.mock.calls[0]?.[1].rows).toHaveLength(501);
      expect(JSON.stringify(result.content)).toContain(
        `Range: 2020-01-01 → ${observations.at(-1)!.date}`,
      );
      expect(JSON.stringify(result.content)).toContain('df_ABC12_DEF34');
      expect(mockGetObservations).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['asc', 'desc'] as const)(
    'returns a complete explicit inline page and continues in %s order',
    async (sort_order) => {
      const ordered = sort_order === 'asc' ? DAILY_ROWS : DAILY_ROWS.toReversed();
      const options = { series_ids: 'DGS10', sort_order, limit: 501 };
      mockGetObservations
        .mockResolvedValueOnce({ ...UNRATE_OBS, observations: ordered.slice(3, 504), count: 550 })
        .mockResolvedValueOnce({ ...UNRATE_OBS, observations: ordered.slice(504), count: 550 });
      const result = await runToolContract(fedreserveGetObservationsTool, {
        ...options,
        offset: 3,
      });
      expect(result.structuredContent).toMatchObject({
        totalCount: 550,
        total_observations: 501,
        series: [{ observation_count: 501, observations: ordered.slice(3, 504) }],
      });
      expect(result.structuredContent).toHaveProperty(
        'message',
        expect.stringContaining('DGS10: 504'),
      );
      expect(JSON.stringify(result.content)).toContain('DGS10: 504');
      expect(JSON.stringify(result.content)).toContain(ordered[503]!.date);
      const next = await runToolContract(fedreserveGetObservationsTool, {
        ...options,
        offset: 504,
      });
      expect(next.structuredContent).toMatchObject({
        total_observations: 46,
        series: [{ observations: ordered.slice(504) }],
      });
      expect(next.structuredContent).not.toHaveProperty(
        'message',
        expect.stringContaining('next offset'),
      );
    },
  );

  it('fetches a bounded implicit page and lists only the continuing series', async () => {
    mockGetObservations
      .mockResolvedValueOnce({ ...UNRATE_OBS, observations: DAILY_ROWS.slice(3, 23), count: 550 })
      .mockResolvedValueOnce({ ...UNRATE_OBS, observations: DAILY_ROWS.slice(3, 18), count: 18 });
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'DGS10,DGS2',
      offset: 3,
    });
    expect(mockGetObservations.mock.calls.map(([params]) => params)).toEqual([
      { series_id: 'DGS10', limit: 20, offset: 3 },
      { series_id: 'DGS2', limit: 20, offset: 3 },
    ]);
    expect(result.structuredContent).toMatchObject({
      totalCount: 568,
      total_observations: 35,
      series: [{ observation_count: 20 }, { observation_count: 15 }],
    });
    expect(result.structuredContent).toHaveProperty(
      'message',
      expect.stringContaining('DGS10: 23'),
    );
    expect(result.structuredContent).not.toHaveProperty(
      'message',
      expect.stringContaining('DGS2:'),
    );
    expect(JSON.stringify(result.content)).toContain('DGS10: 23');
  });

  it('returns the first bounded page after an omitted-limit registration fails', async () => {
    const registerDataframe = vi.fn().mockResolvedValue(undefined);
    mockGetCanvasBridge.mockReturnValue({ registerDataframe });
    mockGetObservations.mockResolvedValueOnce({
      ...UNRATE_OBS,
      observations: DAILY_ROWS.slice(7),
      count: 550,
    });
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'DGS10',
      offset: 7,
    });
    expect(result.structuredContent).toMatchObject({
      totalCount: 550,
      total_observations: 20,
      series: [
        {
          observation_count: 20,
          observation_start: '2020-01-08',
          observation_end: '2020-01-27',
          observations: DAILY_ROWS.slice(7, 27),
        },
      ],
    });
    expect(result.structuredContent).toHaveProperty(
      'message',
      expect.stringContaining('Canvas registration failed.'),
    );
    expect(result.structuredContent).toHaveProperty(
      'message',
      expect.stringContaining('DGS10: 27'),
    );
    expect(JSON.stringify(result.content)).toContain('DGS10: 27');
    expect(registerDataframe).toHaveBeenCalledTimes(1);
    expect(mockGetObservations).toHaveBeenCalledExactlyOnceWith(
      { series_id: 'DGS10', offset: 7 },
      expect.anything(),
    );
  });

  it('keeps each explicit multi-series page intact when registration fails', async () => {
    mockGetCanvasBridge.mockReturnValue({ registerDataframe });
    const rows = DAILY_ROWS.slice(7, 22);
    mockGetObservations.mockResolvedValue({ ...UNRATE_OBS, observations: rows, count: 550 });
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'DGS10,DGS2',
      limit: 15,
      offset: 7,
    });
    expect(result.structuredContent).toMatchObject({
      total_observations: 30,
      series: [{ observations: rows }, { observations: rows }],
    });
    expect(result.structuredContent).toHaveProperty(
      'message',
      expect.stringContaining('DGS10: 22, DGS2: 22'),
    );
    expect(JSON.stringify(result.content)).toContain('DGS10: 22, DGS2: 22');
    expect(mockGetObservations).toHaveBeenCalledTimes(2);
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

  it('preserves HTTP 404 without classifying a generic message as series_not_found', async () => {
    const error = new McpError(JsonRpcErrorCode.NotFound, 'FRED returned HTTP 404.', {
      status: 404,
    });
    mockGetObservations.mockRejectedValueOnce(error);

    const input = fedreserveGetObservationsTool.input.parse({ series_ids: 'MISSING' });
    await expect(fedreserveGetObservationsTool.handler(input, ctx)).rejects.toBe(error);
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
    expect(result.message).toContain('Showing all 4 fetched observations inline.');
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

  it('retains a successful empty series alongside an upstream failure', async () => {
    mockGetObservations
      .mockResolvedValueOnce({ ...UNRATE_OBS, observations: [] })
      .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.Timeout, 'FRED timed out.'));
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: ['UNRATE', 'BAD'],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      series: [
        {
          series_id: 'UNRATE',
          observation_count: 0,
          observation_start: null,
          observation_end: null,
        },
      ],
      failed: [{ series_id: 'BAD', error: 'FRED timed out.' }],
    });
    expect(JSON.stringify(result.content)).toContain('FRED timed out.');
  });

  it('fails an all-failed batch and includes each failure on both surfaces', async () => {
    mockGetCanvasBridge.mockReturnValue({ registerDataframe });
    mockGetObservations
      .mockRejectedValueOnce(new FredDomainError('series_not_found', 'The series does not exist.'))
      .mockRejectedValueOnce(new McpError(JsonRpcErrorCode.Timeout, 'FRED timed out.'));
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: ['BAD1', 'BAD2'],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'partial_failure',
          failed: [
            { series_id: 'BAD1', error: 'The series does not exist.' },
            { series_id: 'BAD2', error: 'FRED timed out.' },
          ],
          recovery: { hint: expect.any(String) },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('BAD1');
    expect(JSON.stringify(result.content)).toContain('FRED timed out.');
    expect(registerDataframe).not.toHaveBeenCalled();
  });

  it('skips canvas for a batch with zero rows', async () => {
    mockGetCanvasBridge.mockReturnValue({ registerDataframe });
    mockGetObservations.mockResolvedValue({ ...UNRATE_OBS, observations: [] });
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: ['UNRATE', 'GDP'],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ total_observations: 0 });
    expect(result.structuredContent).not.toHaveProperty('message');
    expect(JSON.stringify(result.content)).not.toContain('Canvas');
    expect(registerDataframe).not.toHaveBeenCalled();
  });

  it('preserves the single-series upstream code and retry metadata', async () => {
    mockGetObservations.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.RateLimited, 'FRED returned HTTP 429.', {
        status: 429,
        retryAfter: '1',
      }),
    );
    const result = await runToolContract(fedreserveGetObservationsTool, { series_ids: 'UNRATE' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RateLimited, data: { retryAfter: '1' } },
    });
    expect(JSON.stringify(result.content)).toContain('FRED returned HTTP 429.');
  });

  it('rejects reversed dates before observations or metadata requests', async () => {
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'UNRATE',
      observation_start: '2025-01-01',
      observation_end: '2024-01-01',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_observation_range',
          recovery: { hint: expect.any(String) },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('observation_start');
    expect(mockGetObservations).not.toHaveBeenCalled();
    expect(mockGetSeriesById).not.toHaveBeenCalled();
  });

  it('normalizes IDs and discloses deferral on both surfaces', async () => {
    mockGetObservations.mockResolvedValue(UNRATE_OBS);
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: [' unrate,UNRATE, gdp,, id1,id2,id3,id4,id5,id6,id7,id8,id9 ', ''],
    });
    expect(result.isError).toBeFalsy();
    expect(mockGetObservations.mock.calls.map(([params]) => params.series_id)).toEqual([
      'UNRATE',
      'GDP',
      'ID1',
      'ID2',
      'ID3',
      'ID4',
      'ID5',
      'ID6',
      'ID7',
      'ID8',
    ]);
    expect(result.structuredContent).toMatchObject({ deferred_ids: ['ID9'] });
    expect(JSON.stringify(result.content)).toContain('Deferred IDs');
    expect(JSON.stringify(result.content)).toContain('ID9');
  });

  it('forwards explicit paging and renders separate units from FRED metadata', async () => {
    mockGetObservations.mockResolvedValueOnce({ ...UNRATE_OBS, units: 'lin', count: 958 });
    mockGetSeriesById.mockResolvedValueOnce({
      seriess: [{ id: 'CPIAUCSL', units: 'Index 1982-1984=100' }],
    });
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'CPIAUCSL',
      sort_order: 'desc',
      limit: 3,
      offset: 3,
    });
    expect(result.isError).toBeFalsy();
    expect(mockGetObservations).toHaveBeenCalledWith(
      { series_id: 'CPIAUCSL', sort_order: 'desc', limit: 3, offset: 3 },
      expect.anything(),
    );
    expect(mockGetSeriesById).toHaveBeenCalledWith('CPIAUCSL', expect.anything(), 'optional');
    expect(result.structuredContent).toMatchObject({
      series: [
        {
          units: 'lin',
          units_label: 'Levels (No transformation)',
          series_units: 'Index 1982-1984=100',
          observation_count: 3,
        },
      ],
      totalCount: 958,
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain('Levels');
    expect(text).toContain('Index 1982-1984=100');
  });

  it('discloses the annual-rate basis and composes the warning with the canvas notice', async () => {
    mockGetObservations.mockResolvedValue({ ...UNRATE_OBS, units: 'lin' });
    mockGetSeriesById.mockImplementation(async (id) => ({
      seriess: [
        {
          frequency_short: 'Q',
          seasonal_adjustment:
            id === 'GDP' ? 'Seasonally Adjusted Annual Rate' : 'Seasonally Adjusted',
          seasonal_adjustment_short: id === 'GDP' ? 'SAAR' : 'SA',
          units: 'Billions of Dollars',
        },
      ],
    }));
    mockGetCanvasBridge.mockReturnValue({
      registerDataframe: vi.fn().mockResolvedValue({
        tableName: 'df_ABC12_DEF34',
        rowCount: 6,
        expiresAt: '2026-05-22T00:00:00.000Z',
      }),
    });
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'GDP,OTHER',
      frequency: 'a',
      aggregation_method: 'sum',
    });
    expect(result.structuredContent).toMatchObject({
      series: [
        { seasonal_adjustment: 'Seasonally Adjusted Annual Rate' },
        { seasonal_adjustment: 'Seasonally Adjusted' },
      ],
      dataset: { name: 'df_ABC12_DEF34' },
    });
    expect(result.structuredContent).toHaveProperty(
      'notice',
      expect.stringContaining('GDP: sum adds annualized observations'),
    );
    expect(result.structuredContent).not.toHaveProperty(
      'notice',
      expect.stringContaining('OTHER: sum'),
    );
    expect(result.structuredContent).toHaveProperty(
      'notice',
      expect.stringContaining('Staged 6 rows'),
    );
    expect(JSON.stringify(result.content)).toContain('Seasonally Adjusted Annual Rate');
    expect(JSON.stringify(result.content)).toContain('GDP: sum adds annualized observations');
  });

  it('detects the annual-rate basis from native units with sparse adjustment metadata', async () => {
    mockGetObservations.mockResolvedValueOnce({ ...UNRATE_OBS, units: 'lin' });
    mockGetSeriesById.mockResolvedValueOnce({
      seriess: [{ units: 'Dollars at annual rate', frequency_short: 'M', seasonal_adjustment: 12 }],
    });
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'ANNUALIZED',
      units: 'lin',
      frequency: 'q',
      aggregation_method: 'sum',
    });
    expect(result.structuredContent).toMatchObject({
      series: [{ series_units: 'Dollars at annual rate' }],
    });
    expect(result.structuredContent).not.toHaveProperty('series.0.seasonal_adjustment');
    expect(result.structuredContent).toHaveProperty(
      'notice',
      expect.stringContaining('ANNUALIZED: sum adds annualized observations'),
    );
    expect(JSON.stringify(result.content)).toContain(
      'ANNUALIZED: sum adds annualized observations',
    );
  });

  it.each([
    ['native frequency', { frequency: 'q', aggregation_method: 'sum' }, 'Q'],
    ['unknown native frequency', { frequency: 'a', aggregation_method: 'sum' }, undefined],
    ['absent requested frequency', { aggregation_method: 'sum' }, 'Q'],
    ['non-level transform', { frequency: 'a', aggregation_method: 'sum', units: 'pc1' }, 'Q'],
    ['average', { frequency: 'a', aggregation_method: 'avg' }, 'Q'],
    ['end of period', { frequency: 'a', aggregation_method: 'eop' }, 'Q'],
  ] as const)('omits annual-rate guidance for %s', async (_name, input, frequency_short) => {
    mockGetObservations.mockResolvedValueOnce({ ...UNRATE_OBS, units: 'lin' });
    mockGetSeriesById.mockResolvedValueOnce({
      seriess: [{ seasonal_adjustment_short: 'SAAR', frequency_short }],
    });
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'GDP',
      ...input,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty(
      'notice',
      expect.stringContaining('annualized'),
    );
    expect(JSON.stringify(result.content)).not.toContain('annualized');
  });

  it('says aggregation requires a frequency and composes the canvas notice', async () => {
    mockGetObservations.mockResolvedValue(UNRATE_OBS);
    const registerDataframe = vi.fn().mockResolvedValue({
      tableName: 'df_ABC12_DEF34',
      rowCount: 6,
      expiresAt: '2026-05-22T00:00:00.000Z',
    });
    mockGetCanvasBridge.mockReturnValue({ registerDataframe });
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: ['UNRATE', 'GDP'],
      aggregation_method: 'sum',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('aggregation_method applies only when frequency is set'),
    });
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('Staged 6 rows'),
    });
    expect(JSON.stringify(result.content)).toContain('aggregation_method');
    expect(JSON.stringify(result.content)).toContain('Staged 6 rows');
  });

  it.each([
    [],
    [', ', ''],
    ' , ',
    Array.from({ length: 101 }, (_, index) => `S${index}`).join(','),
  ])('rejects empty or oversized batches before fetching (%j)', async (series_ids) => {
    const result = await runToolContract(fedreserveGetObservationsTool, { series_ids });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('series_ids');
    expect(mockGetObservations).not.toHaveBeenCalled();
    expect(mockGetSeriesById).not.toHaveBeenCalled();
  });

  it('advertises and enforces the ten-ID limit when clamping is disabled', async () => {
    const tool = buildFedreserveGetObservationsTool(false);
    const series = Array.from({ length: 11 }, (_, index) => `S${index}`);
    for (const series_ids of [series, series.join(',')]) {
      const result = await runToolContract(tool, { series_ids });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('10');
    }
    expect(mockGetObservations).not.toHaveBeenCalled();
    expect(mockGetSeriesById).not.toHaveBeenCalled();
  });

  it('reports offset-past-end with the declared recovery on both surfaces', async () => {
    mockGetCanvasBridge.mockReturnValue({ registerDataframe });
    mockGetObservations.mockResolvedValueOnce({ ...UNRATE_OBS, observations: [], count: 3 });
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'UNRATE',
      limit: 3,
      offset: 4,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'no_observations_in_range',
          recovery: { hint: expect.stringContaining('smaller offset') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('at offset 4');
    expect(registerDataframe).not.toHaveBeenCalled();
  });

  it.each([0, 100_001])('rejects invalid observation limit %i before fetching', async (limit) => {
    const result = await runToolContract(fedreserveGetObservationsTool, {
      series_ids: 'UNRATE',
      limit,
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(JSON.stringify(result.content)).toContain('limit');
    expect(mockGetObservations).not.toHaveBeenCalled();
    expect(mockGetSeriesById).not.toHaveBeenCalled();
  });

  it.each([
    new McpError(JsonRpcErrorCode.Timeout, 'FRED request timed out.'),
    new McpError(JsonRpcErrorCode.SerializationError, 'FRED API returned invalid JSON.'),
  ])('keeps observations when optional metadata is unavailable', async (failure) => {
    mockGetObservations.mockResolvedValueOnce({ ...UNRATE_OBS, units: 'lin' });
    mockGetSeriesById.mockRejectedValueOnce(failure);
    const result = await runToolContract(fedreserveGetObservationsTool, { series_ids: 'UNRATE' });
    expect(result.isError).toBeFalsy();
    const output = fedreserveGetObservationsTool.output.parse(result.structuredContent);
    expect(output.series[0]).toMatchObject({
      units: 'lin',
      units_label: 'Levels (No transformation)',
    });
    expect(output.series[0]).not.toHaveProperty('series_units');
    expect(JSON.stringify(result.content)).not.toContain('Native series units');
  });

  it('omits native units when optional metadata has a malformed success envelope', async () => {
    mockGetObservations.mockResolvedValueOnce(UNRATE_OBS);
    mockGetSeriesById.mockResolvedValueOnce({});
    const result = await runToolContract(fedreserveGetObservationsTool, { series_ids: 'UNRATE' });
    expect(result.isError).toBeFalsy();
    const output = fedreserveGetObservationsTool.output.parse(result.structuredContent);
    expect(output.series[0]).not.toHaveProperty('series_units');
  });

  it('does not swallow a caller-input or programmer error from metadata', async () => {
    for (const error of [
      new McpError(JsonRpcErrorCode.ValidationError, 'Invalid request to FRED.'),
      new TypeError('Unexpected metadata service defect'),
    ]) {
      mockGetObservations.mockResolvedValueOnce(UNRATE_OBS);
      mockGetSeriesById.mockRejectedValueOnce(error);
      const input = fedreserveGetObservationsTool.input.parse({ series_ids: 'UNRATE' });
      await expect(fedreserveGetObservationsTool.handler(input, ctx)).rejects.toBe(error);
    }
  });

  it('starts metadata alongside pending primary observations and propagates caller cancellation', async () => {
    mockGetCanvasBridge.mockReturnValue({ registerDataframe });
    const controller = new AbortController();
    const cancelled = new DOMException('Client cancelled', 'AbortError');
    const pending = () =>
      new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(cancelled), { once: true });
      });
    mockGetObservations.mockImplementation(pending);
    mockGetSeriesById.mockImplementation(pending);
    const result = fedreserveGetObservationsTool.handler(
      { series_ids: ['UNRATE', 'GDP'] },
      createMockContext({
        errors: fedreserveGetObservationsTool.errors,
        signal: controller.signal,
      }),
    );
    expect(mockGetObservations).toHaveBeenCalledTimes(2);
    expect(mockGetSeriesById).toHaveBeenCalledTimes(2);
    controller.abort(cancelled);
    await expect(result).rejects.toBe(cancelled);
    expect(registerDataframe).not.toHaveBeenCalled();
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

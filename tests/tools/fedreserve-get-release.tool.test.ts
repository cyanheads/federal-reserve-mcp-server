/**
 * @fileoverview Tests for the fedreserve_get_release tool.
 * @module tests/tools/fedreserve-get-release.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fedreserveGetReleaseTool } from '@/mcp-server/tools/definitions/fedreserve-get-release.tool.js';
import { FredDomainError } from '@/services/fred/fred-error.js';

const mockGetRelease = vi.fn();
const mockGetAllReleases = vi.fn();
const mockGetReleaseSeries = vi.fn();
const mockGetReleaseDates = vi.fn();

vi.mock('@/services/fred/fred-service.js', () => ({
  getFredApiService: () => ({
    getRelease: mockGetRelease,
    getAllReleases: mockGetAllReleases,
    getReleaseSeries: mockGetReleaseSeries,
    getReleaseDates: mockGetReleaseDates,
  }),
}));

const RAW_RELEASE = {
  id: 49,
  name: 'Employment Situation',
  press_release: true,
  link: 'https://example.com',
};

const RAW_SERIES_RESP = {
  count: 1,
  seriess: [
    {
      id: 'UNRATE',
      title: 'Unemployment Rate',
      units: 'Percent',
      frequency: 'Monthly',
      seasonal_adjustment: 'Seasonally Adjusted',
      last_updated: '2026-05-01',
    },
  ],
};

const FUTURE_DATE = '2030-01-01';

describe('fedreserveGetReleaseTool', () => {
  let ctx: HandlerContext<ReasonOf<typeof fedreserveGetReleaseTool.errors>>;

  beforeEach(() => {
    ctx = createMockContext({ errors: fedreserveGetReleaseTool.errors });
    mockGetRelease.mockReset();
    mockGetAllReleases.mockReset();
    mockGetReleaseSeries.mockReset();
    mockGetReleaseDates.mockReset();
  });

  it('fetches a release by numeric ID', async () => {
    mockGetRelease.mockResolvedValueOnce({ releases: [RAW_RELEASE] });
    mockGetReleaseSeries.mockResolvedValueOnce(RAW_SERIES_RESP);
    mockGetReleaseDates.mockResolvedValueOnce({
      release_dates: [{ date: FUTURE_DATE, release_id: 49 }],
    });

    const input = fedreserveGetReleaseTool.input.parse({ release_id: 49 });
    const result = await fedreserveGetReleaseTool.handler(input, ctx);

    expect(result.release.id).toBe(49);
    expect(result.release.name).toBe('Employment Situation');
    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.id).toBe('UNRATE');
    expect(result.scheduled_dates).toContain(FUTURE_DATE);
  });

  it.each([
    { dates: [] },
    { dates: [{ date: '2026-10-16' }, { date: '2026-10-17' }, { date: '2026-11-13' }] },
  ])(
    'filters historical schedules while retaining today and upcoming dates: %j',
    async ({ dates }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-17T23:55:00Z'));
      try {
        mockGetRelease.mockResolvedValueOnce({ releases: [RAW_RELEASE] });
        mockGetReleaseSeries.mockResolvedValueOnce(RAW_SERIES_RESP);
        mockGetReleaseDates.mockResolvedValueOnce({ release_dates: dates });
        const result = await runToolContract(fedreserveGetReleaseTool, { release_id: 49 });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          scheduled_dates: dates.length ? ['2026-10-17', '2026-11-13'] : [],
        });
        expect(JSON.stringify(result.content)).not.toContain('2026-10-16');
        expect(JSON.stringify(result.content)).toContain(
          dates.length ? '2026-11-13' : 'None listed',
        );
        expect(result.structuredContent).not.toHaveProperty('scheduled_dates_unavailable');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    JsonRpcErrorCode.ServiceUnavailable,
    JsonRpcErrorCode.RateLimited,
    JsonRpcErrorCode.Timeout,
    JsonRpcErrorCode.NotFound,
    JsonRpcErrorCode.Unauthorized,
    JsonRpcErrorCode.Forbidden,
    JsonRpcErrorCode.SerializationError,
  ])(
    'discloses unavailable schedule %i while retaining primary release and series',
    async (code) => {
      mockGetRelease.mockResolvedValueOnce({ releases: [RAW_RELEASE] });
      mockGetReleaseSeries.mockResolvedValueOnce(RAW_SERIES_RESP);
      mockGetReleaseDates.mockRejectedValueOnce(new McpError(code, 'FRED schedule unavailable'));
      const result = await runToolContract(fedreserveGetReleaseTool, { release_id: 49 });
      expect(result.structuredContent).toMatchObject({
        release: { id: 49 },
        series: [{ id: 'UNRATE' }],
        scheduled_dates: [],
        scheduled_dates_unavailable: true,
      });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining('Scheduled dates:** unavailable (request failed)'),
      });
    },
  );

  it.each([{}, { release_dates: {} }, { release_dates: [{ date: 20300101 }] }])(
    'discloses a malformed schedule on both surfaces: %j',
    async (schedule) => {
      mockGetRelease.mockResolvedValueOnce({ releases: [RAW_RELEASE] });
      mockGetReleaseSeries.mockResolvedValueOnce(RAW_SERIES_RESP);
      mockGetReleaseDates.mockResolvedValueOnce(schedule);
      const result = await runToolContract(fedreserveGetReleaseTool, { release_id: 49 });
      expect(result.structuredContent).toMatchObject({
        release: { id: 49 },
        series: [{ id: 'UNRATE' }],
        scheduled_dates: [],
        scheduled_dates_unavailable: true,
      });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining('Scheduled dates:** unavailable (request failed)'),
      });
    },
  );

  it.each([
    new McpError(JsonRpcErrorCode.ValidationError, 'Invalid schedule parameter', { status: 400 }),
    new McpError(JsonRpcErrorCode.ValidationError, 'Unprocessable schedule parameter', {
      status: 422,
    }),
    new TypeError('Unexpected schedule bug'),
  ])('preserves schedule errors outside upstream unavailability: %s', async (error) => {
    mockGetRelease.mockResolvedValueOnce({ releases: [RAW_RELEASE] });
    mockGetReleaseSeries.mockResolvedValueOnce(RAW_SERIES_RESP);
    mockGetReleaseDates.mockRejectedValueOnce(error);
    const input = fedreserveGetReleaseTool.input.parse({ release_id: 49 });
    await expect(fedreserveGetReleaseTool.handler(input, ctx)).rejects.toBe(error);
  });

  it('propagates cancellation from the schedule branch at the handler boundary', async () => {
    const controller = new AbortController();
    const cancellation = new DOMException('Cancelled by caller', 'AbortError');
    const context = createMockContext({
      errors: fedreserveGetReleaseTool.errors,
      signal: controller.signal,
    });
    mockGetRelease.mockResolvedValueOnce({ releases: [RAW_RELEASE] });
    mockGetReleaseSeries.mockResolvedValueOnce(RAW_SERIES_RESP);
    mockGetReleaseDates.mockImplementationOnce(async () => {
      controller.abort(cancellation);
      throw new McpError(JsonRpcErrorCode.ServiceUnavailable, 'FRED schedule unavailable');
    });
    const input = fedreserveGetReleaseTool.input.parse({ release_id: 49 });
    await expect(fedreserveGetReleaseTool.handler(input, context)).rejects.toBe(cancellation);
  });

  it('shares one deadline across name lookup, release metadata, and the series page', async () => {
    vi.useFakeTimers();
    try {
      mockGetAllReleases.mockImplementationOnce(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({ releases: [RAW_RELEASE] }), 20_000)),
      );
      mockGetRelease.mockImplementationOnce(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({ releases: [RAW_RELEASE] }), 20_000)),
      );
      mockGetReleaseDates.mockResolvedValueOnce({ release_dates: [] });
      const seriesAborted = vi.fn();
      mockGetReleaseSeries.mockImplementationOnce(
        (_params, { signal }: { signal: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const finish = setTimeout(() => resolve(RAW_SERIES_RESP), 20_000);
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
      const result = runToolContract(fedreserveGetReleaseTool, { release_search: 'employment' });
      await vi.advanceTimersByTimeAsync(49_999);
      expect(mockGetReleaseSeries).toHaveBeenCalledTimes(1);
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

  it('keeps primary data when only the optional schedule hits the shared deadline', async () => {
    vi.useFakeTimers();
    try {
      mockGetAllReleases.mockImplementationOnce(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({ releases: [RAW_RELEASE] }), 24_000)),
      );
      mockGetRelease.mockImplementationOnce(
        () =>
          new Promise((resolve) => setTimeout(() => resolve({ releases: [RAW_RELEASE] }), 25_000)),
      );
      mockGetReleaseSeries.mockResolvedValueOnce(RAW_SERIES_RESP);
      mockGetReleaseDates.mockImplementationOnce(
        (_params, { signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      );
      const result = runToolContract(fedreserveGetReleaseTool, { release_search: 'employment' });
      await vi.advanceTimersByTimeAsync(50_000);
      expect((await result).structuredContent).toMatchObject({
        series: [{ id: 'UNRATE' }],
        scheduled_dates_unavailable: true,
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves a non-entity validation error from the release request', async () => {
    mockGetRelease.mockRejectedValueOnce(
      new McpError(JsonRpcErrorCode.ValidationError, 'Invalid release parameter.', {
        body: 'Bad Request. Invalid value for variable release_id.',
      }),
    );
    const result = await runToolContract(fedreserveGetReleaseTool, { release_id: 49 });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, message: 'Invalid release parameter.' },
    });
    expect(JSON.stringify(result.content)).toContain('Invalid release parameter.');
  });

  it('renders the safe FRED message and recovery when a release is missing', async () => {
    mockGetRelease.mockRejectedValueOnce(
      new FredDomainError('release_not_found', 'The release does not exist.'),
    );
    const result = await runToolContract(fedreserveGetReleaseTool, { release_id: 99999 });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: 'The release does not exist.',
        data: {
          reason: 'release_not_found',
          recovery: { hint: expect.stringContaining('release_id') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('The release does not exist.');
    expect(JSON.stringify(result.content)).toContain('Recovery:');
    expect(mockGetReleaseDates).not.toHaveBeenCalled();
  });

  it('resolves a release by name search', async () => {
    mockGetAllReleases.mockResolvedValueOnce({
      releases: [RAW_RELEASE, { id: 10, name: 'Consumer Price Index' }],
    });
    mockGetRelease.mockResolvedValueOnce({ releases: [RAW_RELEASE] });
    mockGetReleaseSeries.mockResolvedValueOnce(RAW_SERIES_RESP);
    mockGetReleaseDates.mockResolvedValueOnce({ release_dates: [] });

    const input = fedreserveGetReleaseTool.input.parse({ release_search: 'employment situation' });
    const result = await fedreserveGetReleaseTool.handler(input, ctx);

    expect(result.release.id).toBe(49);
  });

  it.each([{ release_id: 49 }, { release_search: 'employment situation' }])(
    'renders the full release series total through either lookup: %j',
    async (lookup) => {
      for (const offset of [0, 1, 100]) {
        mockGetAllReleases.mockResolvedValueOnce({ releases: [RAW_RELEASE] });
        mockGetRelease.mockResolvedValueOnce({ releases: [RAW_RELEASE] });
        mockGetReleaseSeries.mockResolvedValueOnce({
          ...RAW_SERIES_RESP,
          count: 77,
          seriess: offset === 100 ? [] : RAW_SERIES_RESP.seriess,
        });
        mockGetReleaseDates.mockResolvedValueOnce({ release_dates: [] });
        const result = await runToolContract(fedreserveGetReleaseTool, {
          ...lookup,
          series_limit: 1,
          series_offset: offset,
        });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          series_count: 77,
          totalCount: 77,
          series_offset: offset,
        });
        expect(result.content.at(-1)).toMatchObject({ text: expect.stringContaining('77 total') });
        expect(mockGetReleaseSeries).toHaveBeenLastCalledWith(
          { release_id: 49, limit: 1, offset },
          expect.anything(),
        );
      }
    },
  );

  it.each([{}, { release_search: '  ' }, { release_id: 49, release_search: 'employment' }])(
    'preserves the exactly-one lookup recovery on both surfaces: %j',
    async (input) => {
      const result = await runToolContract(fedreserveGetReleaseTool, input);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'missing_input', recovery: { hint: expect.any(String) } } },
      });
      expect(JSON.stringify(result.content)).toContain('Recovery:');
      expect(mockGetRelease).not.toHaveBeenCalled();
      expect(mockGetAllReleases).not.toHaveBeenCalled();
    },
  );

  it('preserves ambiguous alternatives and recovery in the final error', async () => {
    const alternatives = [
      { id: 49, name: 'Employment Situation' },
      { id: 50, name: 'Employment Costs Index' },
    ];
    mockGetAllReleases.mockResolvedValueOnce({ releases: alternatives });
    const result = await runToolContract(fedreserveGetReleaseTool, {
      release_search: 'employment',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'ambiguous_release_search',
          search_alternatives: alternatives,
          recovery: { hint: expect.any(String) },
        },
      },
    });
    for (const alternative of alternatives)
      expect(JSON.stringify(result.content)).toContain(alternative.name);
    expect(JSON.stringify(result.content)).toContain('Recovery:');
    expect(mockGetRelease).not.toHaveBeenCalled();
  });

  it('throws release_not_found when search matches nothing', async () => {
    mockGetAllReleases.mockResolvedValueOnce({
      releases: [{ id: 10, name: 'Consumer Price Index' }],
    });

    const input = fedreserveGetReleaseTool.input.parse({ release_search: 'xyzzy nonexistent' });
    await expect(fedreserveGetReleaseTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'release_not_found' },
    });
  });

  it('throws ambiguous_release_search when multiple releases match with no exact hit', async () => {
    mockGetAllReleases.mockResolvedValueOnce({
      releases: [
        { id: 49, name: 'Employment Situation' },
        { id: 50, name: 'Employment Costs Index' },
      ],
    });

    const input = fedreserveGetReleaseTool.input.parse({ release_search: 'employment' });
    await expect(fedreserveGetReleaseTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'ambiguous_release_search' },
    });
  });

  it('throws when neither release_id nor release_search provided', async () => {
    const input = fedreserveGetReleaseTool.input.parse({});
    await expect(fedreserveGetReleaseTool.handler(input, ctx)).rejects.toThrow();
  });

  it('format renders release name, ID, and series list', () => {
    const output = {
      release: { id: 49, name: 'Employment Situation', press_release: true },
      scheduled_dates: [FUTURE_DATE],
      series_count: 1,
      series_offset: 0,
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
    };
    const blocks = fedreserveGetReleaseTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Employment Situation');
    expect(text).toContain('49');
    expect(text).toContain('UNRATE');
    expect(text).toContain(FUTURE_DATE);
  });
});

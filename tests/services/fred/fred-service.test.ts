/**
 * @fileoverview Tests for FredApiService — retry logic, HTML error detection,
 * parallel fan-out, and 429 handling.
 * @module tests/services/fred/fred-service.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub global fetch before importing the service module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Stub getServerConfig before importing service (avoids FRED_API_KEY requirement)
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => ({
    baseUrl: 'https://api.stlouisfed.org/fred',
    apiKey: 'test-key',
    datasetTtlSeconds: 86400,
    dropEnabled: false,
  }),
}));

// Dynamically import after stubs are set up
const { FredApiService } = await import('@/services/fred/fred-service.js');

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeErrorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    text: async () => statusText,
    headers: { get: () => null },
    url: '',
  } as unknown as Response;
}

describe('FredApiService', () => {
  let service: InstanceType<typeof FredApiService>;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    service = new FredApiService();
    ctx = createMockContext();
    mockFetch.mockReset().mockRejectedValue(new Error('Unexpected fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('searchSeries builds the correct URL and returns parsed JSON', async () => {
    mockFetch.mockResolvedValueOnce(
      makeOkResponse({
        count: 1,
        offset: 0,
        limit: 1000,
        seriess: [{ id: 'UNRATE', title: 'Unemployment Rate' }],
      }),
    );

    const result = await service.searchSeries({ query: 'unemployment' }, ctx);

    expect(result.count).toBe(1);
    expect(result.seriess[0]?.id).toBe('UNRATE');

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/series/search');
    expect(calledUrl).toContain('search_text=unemployment');
    expect(calledUrl).toContain('api_key=test-key');
  });

  it('getSeriesById fires a request to /series with the series_id param', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ seriess: [{ id: 'FEDFUNDS' }] }));

    const result = await service.getSeriesById('FEDFUNDS', ctx);

    expect(result.seriess[0]?.id).toBe('FEDFUNDS');
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/series');
    expect(calledUrl).toContain('series_id=FEDFUNDS');
  });

  it('getObservations includes optional params in the query string', async () => {
    mockFetch.mockResolvedValueOnce(
      makeOkResponse({
        observation_start: '2020-01-01',
        observation_end: '2020-12-01',
        units: 'lin',
        observations: [{ date: '2020-01-01', value: '3.5' }],
      }),
    );

    await service.getObservations(
      {
        series_id: 'UNRATE',
        observation_start: '2020-01-01',
        observation_end: '2020-12-01',
        units: 'pc1',
        frequency: 'm',
        aggregation_method: 'avg',
      },
      ctx,
    );

    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/series/observations');
    expect(calledUrl).toContain('observation_start=2020-01-01');
    expect(calledUrl).toContain('units=pc1');
    expect(calledUrl).toContain('frequency=m');
    expect(calledUrl).toContain('aggregation_method=avg');
  });

  it('throws when FRED returns an HTML error page (rate-limit detection)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () => '<!DOCTYPE html><html><body>Rate limit exceeded</body></html>',
    } as unknown as Response);

    await expect(service.searchSeries({ query: 'test' }, ctx)).rejects.toThrow(
      'HTML instead of JSON',
    );
  });

  it('throws on non-ok HTTP responses', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(404, 'Not Found'));

    await expect(service.getSeriesById('BOGUS', ctx)).rejects.toThrow();
  });

  it.each([
    ['series', 'The series does not exist.', 'series_not_found'],
    ['category', 'The category does not exist.', 'category_not_found'],
    ['release', 'The release does not exist.', 'release_not_found'],
  ])('classifies the exact missing %s response', async (entity, message, reason) => {
    mockFetch.mockResolvedValueOnce(
      Response.json(
        { error_code: 400, error_message: `Bad Request.  ${message}` },
        { status: 400 },
      ),
    );
    const request =
      entity === 'series'
        ? service.getSeriesById('zzXNoFred20261111', ctx)
        : entity === 'category'
          ? service.getCategory(2147483647, ctx)
          : service.getRelease(2147483647, ctx);
    await expect(request).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      reason,
      message,
      data: { status: 400, reason },
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns safe validation text for an unknown tag rather than an entity reason', async () => {
    const message = 'Value "zzxfredtag20261111" for variable tag_names does not exist.';
    mockFetch.mockResolvedValueOnce(
      Response.json(
        { error_code: 400, error_message: `Bad Request.  ${message}` },
        { status: 400 },
      ),
    );
    await expect(
      service.searchSeries({ query: 'unemployment', tag_names: 'zzxfredtag20261111' }, ctx),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.ValidationError, message });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the allowed-frequency list for a native-frequency restriction', async () => {
    const message = "Value of frequency is not one of: 'q', 'sa', 'a'.";
    mockFetch.mockResolvedValueOnce(
      Response.json(
        { error_code: 400, error_message: `Bad Request.  ${message}` },
        { status: 400 },
      ),
    );
    await expect(
      service.getObservations({ series_id: 'GDP', frequency: 'm' }, ctx),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      reason: 'frequency_too_high',
      message,
    });
  });

  it('keeps upstream bodies and credential-bearing status text out of errors and logs', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('PRIVATE_BODY test-key', {
        status: 400,
        statusText: 'https://api.stlouisfed.org/fred/series?api_key=test-key',
      }),
    );
    const error = await service.getSeriesById('UNRATE', ctx).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'FRED returned HTTP 400.',
      data: { status: 400 },
    });
    expect(JSON.stringify(error)).not.toMatch(/test-key|PRIVATE_BODY|api_key/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('passes observation sorting and paging through to FRED', async () => {
    mockFetch.mockResolvedValueOnce(Response.json({ count: 16920, observations: [] }));
    const page = await service.getObservations(
      { series_id: 'DGS10', sort_order: 'desc', limit: 3, offset: 16920 },
      ctx,
    );
    const query = new URL(mockFetch.mock.calls[0]?.[0] as string).searchParams;
    expect(Object.fromEntries(query)).toMatchObject({
      sort_order: 'desc',
      limit: '3',
      offset: '16920',
    });
    expect(page).toMatchObject({ count: 16920, observations: [] });
  });

  it.each(['category', 'release'])('requests popularity order across %s pages', async (entity) => {
    mockFetch.mockResolvedValueOnce(Response.json({ count: 820, offset: 2, seriess: [] }));
    const result =
      entity === 'category'
        ? await service.getCategorySeries({ category_id: 32447, limit: 5, offset: 2 }, ctx)
        : await service.getReleaseSeries({ release_id: 50, limit: 5, offset: 2 }, ctx);
    const url = new URL(mockFetch.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe(`/fred/${entity}/series`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      order_by: 'popularity',
      sort_order: 'desc',
      limit: '5',
      offset: '2',
    });
    expect(result).toMatchObject({ count: 820, offset: 2, seriess: [] });
  });

  it('fetches a series release using the release envelope', async () => {
    mockFetch.mockResolvedValueOnce(
      Response.json({ releases: [{ id: 50, name: 'Employment Situation' }] }),
    );
    await expect(service.getSeriesRelease('UNRATE', ctx)).resolves.toMatchObject({
      releases: [{ id: 50, name: 'Employment Situation' }],
    });
    const url = new URL(mockFetch.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/fred/series/release');
    expect(url.searchParams.get('series_id')).toBe('UNRATE');
  });

  it.each([
    { error_code: 404, error_message: 'Bad Request.  The series does not exist.' },
    { error_code: 400, error_message: 42 },
    { error_code: 400, error_message: 'Bad Request.  Invalid credential test-key.' },
    { error_code: 400, error_message: 'Bad Request.  https://user:pass@host.test/path' },
  ])('uses the generic validation message for malformed or unsafe diagnostics', async (body) => {
    mockFetch.mockResolvedValueOnce(Response.json(body, { status: 400 }));
    const error = await service.getSeriesById('UNRATE', ctx).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: 'FRED returned HTTP 400.',
      data: { status: 400 },
    });
    expect(JSON.stringify(error)).not.toMatch(/test-key|user:pass|error_message/);
  });

  it('does not retry a fully read invalid JSON response', async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValue(new Response('{ "api_key": "test-key"'));
      const outcome = expect(service.getSeriesById('UNRATE', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.SerializationError,
        message: 'FRED API returned invalid JSON.',
      });
      await vi.runAllTimersAsync();
      await outcome;
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a network failure and honors Retry-After on a later attempt', async () => {
    vi.useFakeTimers();
    try {
      mockFetch
        .mockRejectedValueOnce(new TypeError('network request failed'))
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '4' } }))
        .mockResolvedValueOnce(Response.json({ seriess: [{ id: 'UNRATE' }] }));
      const result = service.getSeriesById('UNRATE', ctx);
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4000);
      await expect(result).resolves.toMatchObject({ seriess: [{ id: 'UNRATE' }] });
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [429, JsonRpcErrorCode.RateLimited],
    [503, JsonRpcErrorCode.ServiceUnavailable],
    [504, JsonRpcErrorCode.Timeout],
  ])('preserves the last HTTP %i code and retry metadata', async (status, code) => {
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementation(
        async () => new Response(null, { status, headers: { 'Retry-After': '1' } }),
      );
      const outcome = expect(service.getSeriesById('UNRATE', ctx)).rejects.toMatchObject({
        code,
        data: { status, retryAfter: '1', retryAttempts: 4 },
      });
      await vi.runAllTimersAsync();
      await outcome;
      expect(mockFetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([425, 501, 505])(
    'fails without retrying a non-transient HTTP %i response',
    async (status) => {
      vi.useFakeTimers();
      try {
        mockFetch.mockImplementation(async () => new Response(null, { status }));
        const outcome = expect(service.getSeriesById('UNRATE', ctx)).rejects.toMatchObject({
          data: { status, retryable: false },
        });
        await vi.runAllTimersAsync();
        await outcome;
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('does not retry a transient error on the optional release dates path', async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementation(
        async () => new Response(null, { status: 503, headers: { 'Retry-After': '1' } }),
      );
      const outcome = expect(
        service.getReleaseDates({ release_id: 50 }, ctx),
      ).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { status: 503, retryAfter: '1' },
      });
      await vi.runAllTimersAsync();
      await outcome;
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds all attempts including a body read in flight', async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementation(
        async (_url: string, { signal }: { signal: AbortSignal }) =>
          new Response(
            new ReadableStream({
              start(stream) {
                signal.addEventListener('abort', () => stream.error(signal.reason), { once: true });
              },
            }),
          ),
      );
      const outcome = expect(service.getSeriesById('UNRATE', ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: 45_000, retryAttempts: 3 },
      });
      await vi.advanceTimersByTimeAsync(45_000);
      await outcome;
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a stalled metadata lookup at two seconds alongside a fast primary', async () => {
    vi.useFakeTimers();
    try {
      mockFetch
        .mockResolvedValueOnce(
          Response.json({ observations: [{ date: '2026-11-09', value: '4.19' }] }),
        )
        .mockImplementationOnce(
          (_url: string, { signal }: { signal: AbortSignal }) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
        );
      const primary = service.getObservations({ series_id: 'DGS10' }, ctx);
      const optional = service.getSeriesById('DGS10', ctx, 'optional');
      await expect(primary).resolves.toMatchObject({
        observations: [{ date: '2026-11-09', value: '4.19' }],
      });
      const outcome = expect(optional).rejects.toMatchObject({
        code: JsonRpcErrorCode.Timeout,
        data: { timeoutMs: 2000 },
      });
      await vi.advanceTimersByTimeAsync(2000);
      await outcome;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates caller cancellation from an optional release read', async () => {
    const controller = new AbortController();
    const cancelled = new DOMException('Client cancelled', 'AbortError');
    mockFetch.mockImplementationOnce(
      (_url: string, { signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const pending = service.getSeriesRelease(
      'UNRATE',
      createMockContext({ signal: controller.signal }),
    );
    controller.abort(cancelled);
    await expect(pending).rejects.toBe(cancelled);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('parallel getObservations calls resolve independently', async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeOkResponse({
          observation_start: '2020-01-01',
          observation_end: '2020-03-01',
          units: 'Percent',
          observations: [{ date: '2020-01-01', value: '3.5' }],
        }),
      )
      .mockResolvedValueOnce(
        makeOkResponse({
          observation_start: '2020-01-01',
          observation_end: '2020-03-01',
          units: 'Percent',
          observations: [{ date: '2020-01-01', value: '2.1' }],
        }),
      );

    const [r1, r2] = await Promise.all([
      service.getObservations({ series_id: 'UNRATE' }, ctx),
      service.getObservations({ series_id: 'FEDFUNDS' }, ctx),
    ]);

    expect(r1.observations[0]?.value).toBe('3.5');
    expect(r2.observations[0]?.value).toBe('2.1');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('getAllReleases calls /releases with limit=1000', async () => {
    mockFetch.mockResolvedValueOnce(
      makeOkResponse({ releases: [{ id: 49, name: 'Employment Situation' }] }),
    );

    const result = await service.getAllReleases(ctx);

    expect(result.releases).toHaveLength(1);
    const calledUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/releases');
    expect(calledUrl).toContain('limit=1000');
  });

  it('requests only the nearest five nonpast release dates, including dates without data', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T23:55:00Z'));
    try {
      const dates = [
        '2020-01-01',
        '2026-10-16',
        '2026-10-17',
        '2026-11-13',
        '2026-12-10',
        '2027-01-14',
        '2027-02-11',
        '2030-01-01',
      ];
      mockFetch.mockImplementationOnce(async (input: string) => {
        const query = new URL(input).searchParams;
        expect(query.get('include_release_dates_with_no_data')).toBe('true');
        expect(query.get('realtime_start')).toBe('2026-10-17');
        expect(query.get('sort_order')).toBe('asc');
        expect(query.get('limit')).toBe('5');
        expect(query.get('release_id')).toBe('10');
        return makeOkResponse({
          release_dates: dates
            .filter((date) => date >= query.get('realtime_start')!)
            .slice(0, Number(query.get('limit')))
            .map((date) => ({ date, release_id: 10 })),
        });
      });
      const result = await service.getReleaseDates({ release_id: 10 }, ctx);
      expect(result.release_dates.map((date) => date.date)).toEqual([
        '2026-10-17',
        '2026-11-13',
        '2026-12-10',
        '2027-01-14',
        '2027-02-11',
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

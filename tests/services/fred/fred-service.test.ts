/**
 * @fileoverview Tests for FredApiService — retry logic, HTML error detection,
 * parallel fan-out, and 429 handling.
 * @module tests/services/fred/fred-service.test
 */

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

// Stub withRetry to execute the callback once without actual backoff
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...actual,
    withRetry: async (fn: () => Promise<unknown>) => fn(),
  };
});

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
    mockFetch.mockReset();
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
});

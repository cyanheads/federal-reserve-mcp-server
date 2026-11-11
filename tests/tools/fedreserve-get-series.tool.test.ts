/**
 * @fileoverview Tests for the fedreserve_get_series tool.
 * @module tests/tools/fedreserve-get-series.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import {
  rateLimited,
  serializationError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFedreserveGetSeriesTool,
  fedreserveGetSeriesTool,
} from '@/mcp-server/tools/definitions/fedreserve-get-series.tool.js';
import { FredDomainError } from '@/services/fred/fred-error.js';

const mockGetSeriesById = vi.fn();
const mockGetSeriesRelease = vi.fn();

vi.mock('@/services/fred/fred-service.js', () => ({
  getFredApiService: () => ({
    getSeriesById: mockGetSeriesById,
    getSeriesRelease: mockGetSeriesRelease,
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
    mockGetSeriesRelease.mockReset();
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

  it('normalizes comma-separated IDs and fetches each canonical ID once', async () => {
    mockGetSeriesById.mockImplementation(async (id: string) => ({
      seriess: [{ ...UNRATE_RAW, id }],
    }));
    const result = await runToolContract(fedreserveGetSeriesTool, {
      series_ids: [' unrate, GDP ', 'UNRATE', ',', ''],
    });
    expect(result.isError).toBeFalsy();
    expect(mockGetSeriesById.mock.calls.map(([id]) => id)).toEqual(['UNRATE', 'GDP']);
    expect(result.structuredContent).toMatchObject({ series: [{ id: 'UNRATE' }, { id: 'GDP' }] });
  });

  it('defers a metadata batch beyond 50 without fetching deferred IDs', async () => {
    mockGetSeriesById.mockImplementation(async (id: string) => ({
      seriess: [{ ...UNRATE_RAW, id }],
    }));
    const result = await runToolContract(fedreserveGetSeriesTool, {
      series_ids: Array.from({ length: 51 }, (_, i) => `ID${i}`),
    });
    expect(result.isError).toBeFalsy();
    expect(mockGetSeriesById).toHaveBeenCalledTimes(50);
    expect(result.structuredContent).toMatchObject({ deferred_ids: ['ID50'] });
    expect(JSON.stringify(result.content)).toContain('ID50');
  });

  it.each([
    rateLimited('FRED is rate limited.'),
    serviceUnavailable('FRED is unavailable.'),
    timeout('FRED timed out.'),
  ])('preserves a single-series upstream error', async (error) => {
    mockGetSeriesById.mockRejectedValueOnce(error);
    const result = await runToolContract(fedreserveGetSeriesTool, { series_ids: 'UNRATE' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: error.code } });
    expect(JSON.stringify(result.content)).not.toContain('Verify the series ID');
  });

  it('adds release mapping only when requested and renders its ID and name', async () => {
    mockGetSeriesById.mockResolvedValue({ seriess: [UNRATE_RAW] });
    mockGetSeriesRelease.mockResolvedValue({
      releases: [{ id: 50, name: 'Employment Situation' }],
    });
    await runToolContract(fedreserveGetSeriesTool, { series_ids: 'UNRATE' });
    expect(mockGetSeriesRelease).not.toHaveBeenCalled();
    const result = await runToolContract(fedreserveGetSeriesTool, {
      series_ids: 'UNRATE',
      include_release: true,
    } as never);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      series: [{ release: { id: 50, name: 'Employment Situation' } }],
    });
    expect(JSON.stringify(result.content)).toContain('Employment Situation');
    expect(JSON.stringify(result.content)).toContain('50');
  });

  it.each([
    serviceUnavailable('FRED is unavailable.'),
    serializationError('FRED returned invalid JSON.'),
  ])('keeps metadata and discloses an unavailable release lookup', async (error) => {
    mockGetSeriesById.mockResolvedValue({ seriess: [UNRATE_RAW] });
    mockGetSeriesRelease.mockRejectedValue(error);
    const result = await runToolContract(fedreserveGetSeriesTool, {
      series_ids: 'UNRATE',
      include_release: true,
    } as never);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      series: [{ id: 'UNRATE' }],
      notice: expect.stringContaining('UNRATE'),
    });
    const output = fedreserveGetSeriesTool.output.parse(result.structuredContent);
    expect(output.series[0]).not.toHaveProperty('release');
    expect(JSON.stringify(result.content)).toContain('unavailable');
  });

  it('propagates caller cancellation after batch settlement', async () => {
    const controller = new AbortController();
    const aborted = createMockContext({
      errors: fedreserveGetSeriesTool.errors,
      signal: controller.signal,
    });
    mockGetSeriesById.mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    const input = fedreserveGetSeriesTool.input.parse({ series_ids: ['UNRATE', 'GDP'] });
    await expect(fedreserveGetSeriesTool.handler(input, aborted)).rejects.toBe(
      controller.signal.reason,
    );
  });

  it('maps an exact missing series error to the declared recovery', async () => {
    mockGetSeriesById.mockRejectedValue(
      new FredDomainError('series_not_found', 'The series does not exist.'),
    );
    const result = await runToolContract(fedreserveGetSeriesTool, { series_ids: 'MISSING' });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'series_not_found' } },
    });
    expect(JSON.stringify(result.content)).toContain('Verify the series ID');
  });

  it.each(['', ' , , ', Array.from({ length: 101 }, (_, i) => `ID${i}`).join(',')])(
    'rejects an empty or over-cap normalized batch without fetching',
    async (series_ids) => {
      const result = await runToolContract(fedreserveGetSeriesTool, { series_ids });
      expect(result.isError).toBe(true);
      expect(mockGetSeriesById).not.toHaveBeenCalled();
    },
  );

  it('restores both array and comma-string bounds with deferral disabled', async () => {
    const strict = buildFedreserveGetSeriesTool(false);
    const ids = Array.from({ length: 51 }, (_, i) => `ID${i}`);
    for (const series_ids of [ids, ids.join(',')]) {
      const result = await runToolContract(strict, { series_ids });
      expect(result.isError).toBe(true);
    }
    expect(mockGetSeriesById).not.toHaveBeenCalled();
    expect(strict.input.safeParse({ series_ids: ids.slice(0, 50) }).success).toBe(true);
  });

  it('accepts 100 IDs and requests releases only for successful processed IDs', async () => {
    mockGetSeriesById.mockImplementation(async (id: string) => {
      if (id === 'ID1') throw new FredDomainError('series_not_found', 'The series does not exist.');
      return { seriess: [{ ...UNRATE_RAW, id }] };
    });
    mockGetSeriesRelease.mockResolvedValue({ releases: [] });
    const result = await runToolContract(fedreserveGetSeriesTool, {
      series_ids: Array.from({ length: 100 }, (_, i) => `ID${i}`),
      include_release: true,
    });
    expect(result.isError).toBeFalsy();
    expect(mockGetSeriesById).toHaveBeenCalledTimes(50);
    expect(mockGetSeriesRelease).toHaveBeenCalledTimes(49);
    expect(mockGetSeriesRelease.mock.calls.map(([id]) => id)).not.toContain('ID1');
    expect(mockGetSeriesRelease.mock.calls.map(([id]) => id)).not.toContain('ID50');
    expect(result.structuredContent).toMatchObject({
      failed: [{ id: 'ID1', error: 'The series does not exist.' }],
      notice: expect.stringContaining('ID0'),
    });
    expect(JSON.stringify(result.content)).toContain('The series does not exist.');
  });

  it('does not turn secondary validation failures into a success', async () => {
    mockGetSeriesById.mockResolvedValue({ seriess: [UNRATE_RAW] });
    mockGetSeriesRelease.mockRejectedValue(validationError('Invalid release parameter.'));
    const result = await runToolContract(fedreserveGetSeriesTool, {
      series_ids: 'UNRATE',
      include_release: true,
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Invalid release parameter.');
  });

  it.each([{}, { releases: [{}] }, { releases: null }])(
    'marks malformed optional release envelopes unavailable',
    async (releaseResponse) => {
      mockGetSeriesById.mockResolvedValue({ seriess: [UNRATE_RAW] });
      mockGetSeriesRelease.mockResolvedValue(releaseResponse);
      const result = await runToolContract(fedreserveGetSeriesTool, {
        series_ids: 'UNRATE',
        include_release: true,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        series: [{ id: 'UNRATE' }],
        notice: expect.stringContaining('UNRATE'),
      });
      expect(
        fedreserveGetSeriesTool.output.parse(result.structuredContent).series[0],
      ).not.toHaveProperty('release');
      expect(JSON.stringify(result.content)).toContain('unavailable');
    },
  );

  it('retains deferred IDs and individual errors on both all-failed surfaces', async () => {
    mockGetSeriesById.mockRejectedValue(
      new FredDomainError('series_not_found', 'The series does not exist.'),
    );
    const result = await runToolContract(fedreserveGetSeriesTool, {
      series_ids: Array.from({ length: 51 }, (_, i) => `ID${i}`),
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'partial_failure',
          deferred_ids: ['ID50'],
          failed: expect.arrayContaining([{ id: 'ID0', error: 'The series does not exist.' }]),
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('ID50');
    expect(JSON.stringify(result.content)).toContain('The series does not exist.');
  });

  it('propagates cancellation during an optional release lookup', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Caller cancelled', 'AbortError');
    mockGetSeriesById.mockResolvedValue({ seriess: [UNRATE_RAW] });
    mockGetSeriesRelease.mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    const context = createMockContext({
      errors: fedreserveGetSeriesTool.errors,
      signal: controller.signal,
    });
    const input = fedreserveGetSeriesTool.input.parse({
      series_ids: 'UNRATE',
      include_release: true,
    });
    await expect(fedreserveGetSeriesTool.handler(input, context)).rejects.toBe(reason);
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

  /**
   * The alias rewrite runs inside `parseToolArguments`, so it is only reachable
   * through the contract boundary — a direct `handler()` call skips it.
   */
  describe('input aliases', () => {
    it('accepts FRED’s singular series_id under the declared series_ids', async () => {
      mockGetSeriesById.mockResolvedValueOnce({ seriess: [UNRATE_RAW] });

      const result = await runToolContract(fedreserveGetSeriesTool, {
        series_id: 'UNRATE',
      } as never);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ series: [{ id: 'UNRATE' }] });
      expect(mockGetSeriesById).toHaveBeenCalledWith('UNRATE', expect.anything());
    });

    it('does not advertise the alias on inputSchema', () => {
      const shape = Object.keys(fedreserveGetSeriesTool.input.shape);
      expect(shape).toEqual(['series_ids', 'include_release']);
    });

    it('rejects an undeclared key that is not an alias', async () => {
      const result = await runToolContract(fedreserveGetSeriesTool, {
        series_ids: 'UNRATE',
        seriesID_typo: 'UNRATE',
      } as never);

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('seriesID_typo');
    });
  });
});

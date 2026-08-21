/**
 * @fileoverview Tests for the fedreserve_get_release tool.
 * @module tests/tools/fedreserve-get-release.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fedreserveGetReleaseTool } from '@/mcp-server/tools/definitions/fedreserve-get-release.tool.js';

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

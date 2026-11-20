/**
 * @fileoverview Release calendar tool contract tests.
 * @module tests/tools/fedreserve-list-release-dates.tool.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fedreserveListReleaseDatesTool } from '@/mcp-server/tools/definitions/fedreserve-list-release-dates.tool.js';

const listReleaseDates = vi.fn();
vi.mock('@/services/fred/fred-service.js', () => ({
  getFredApiService: () => ({ listReleaseDates }),
}));

const run = (input: Record<string, unknown>) =>
  runToolContract(fedreserveListReleaseDatesTool, input);

describe('fedreserve_list_release_dates', () => {
  beforeEach(() => listReleaseDates.mockReset());

  it('forwards a same-day window and formats a later page with its total', async () => {
    const release = { date: '2026-11-20', release_id: 53, release_name: 'Gross Domestic Product' };
    listReleaseDates.mockResolvedValueOnce({
      count: 2501,
      limit: 1000,
      offset: 2000,
      release_dates: [release],
    });
    const result = await run({
      start_date: release.date,
      end_date: release.date,
      limit: 1000,
      offset: 2000,
    });
    expect(listReleaseDates).toHaveBeenCalledWith(
      { start_date: release.date, end_date: release.date, limit: 1000, offset: 2000 },
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      dates: [release],
      totalCount: 2501,
      offset: 2000,
    });
    expect(JSON.stringify(result.content)).toContain('1 shown, offset 2000');
    expect(JSON.stringify(result.content).match(/2501/g)).toHaveLength(1);
    expect(JSON.stringify(result.content)).toContain(
      '2026-11-20 · Gross Domestic Product (ID: 53)',
    );
  });

  it('defaults the window in UTC even when it crosses a month boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-28T00:01Z'));
    try {
      listReleaseDates.mockResolvedValueOnce({ count: 0, limit: 50, offset: 0, release_dates: [] });
      const result = await run({});
      expect(listReleaseDates).toHaveBeenCalledWith(
        { start_date: '2026-11-28', end_date: '2026-12-05', limit: 50, offset: 0 },
        expect.anything(),
      );
      expect(result.structuredContent).toMatchObject({ dates: [], totalCount: 0, offset: 0 });
      expect(result.structuredContent).toMatchObject({
        notice: 'No scheduled releases in this date window.',
      });
      expect(JSON.stringify(result.content)).toContain('No scheduled releases');
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes an offset past the end from an empty window', async () => {
    listReleaseDates.mockResolvedValueOnce({
      count: 196,
      limit: 50,
      offset: 250,
      release_dates: [],
    });
    const result = await run({ start_date: '2026-11-16', end_date: '2026-11-20', offset: 250 });
    expect(result.structuredContent).toMatchObject({ dates: [], totalCount: 196, offset: 250 });
    expect(result.structuredContent).toMatchObject({
      notice: 'The offset is past the end of this date window.',
    });
    expect(JSON.stringify(result.content)).toContain('The offset is past the end');
  });

  it('returns the date window recovery and avoids upstream work for reversed dates', async () => {
    const result = await run({ start_date: '2026-11-20', end_date: '2026-11-16' });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'invalid_date_window',
          recovery: { hint: expect.stringContaining('end_date') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('Recovery:');
    expect(listReleaseDates).not.toHaveBeenCalled();
  });

  it.each([{ start_date: '2026-02-30' }, { limit: 1001 }, { offset: -1 }])(
    'rejects invalid input %j',
    async (input) => {
      expect((await run(input)).isError).toBe(true);
      expect(listReleaseDates).not.toHaveBeenCalled();
    },
  );
});

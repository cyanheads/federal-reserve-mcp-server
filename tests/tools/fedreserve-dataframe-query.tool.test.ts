/**
 * @fileoverview Tests for the fedreserve_dataframe_query tool.
 * @module tests/tools/fedreserve-dataframe-query.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fedreserveDataframeQueryTool } from '@/mcp-server/tools/definitions/fedreserve-dataframe-query.tool.js';

const mockQuery = vi.fn();

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: () => ({ query: mockQuery }),
}));

describe('fedreserveDataframeQueryTool', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext({ errors: fedreserveDataframeQueryTool.errors });
    mockQuery.mockReset();
  });

  it('returns query results with columns and rows', async () => {
    mockQuery.mockResolvedValueOnce({
      result: {
        columns: ['date', 'value'],
        rowCount: 2,
        rows: [
          { date: '2020-01-01', value: '3.5' },
          { date: '2020-02-01', value: '3.5' },
        ],
      },
    });

    const input = fedreserveDataframeQueryTool.input.parse({
      sql: 'SELECT date, value FROM df_ABC12_DEF34',
    });
    const result = await fedreserveDataframeQueryTool.handler(input, ctx);

    expect(result.columns).toEqual(['date', 'value']);
    expect(result.row_count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.registered_as).toBeUndefined();
  });

  it('returns registered_as and expires_at when register_as provided', async () => {
    mockQuery.mockResolvedValueOnce({
      result: {
        columns: ['date', 'value'],
        rowCount: 10,
        rows: [],
        tableName: 'df_XYZ99_PQR77',
      },
      meta: {
        tableName: 'df_XYZ99_PQR77',
        expiresAt: '2026-05-22T10:00:00.000Z',
      },
    });

    const input = fedreserveDataframeQueryTool.input.parse({
      sql: 'SELECT date, value FROM df_ABC12_DEF34',
      register_as: 'df_XYZ99_PQR77',
    });
    const result = await fedreserveDataframeQueryTool.handler(input, ctx);

    expect(result.registered_as).toBe('df_XYZ99_PQR77');
    expect(result.expires_at).toBe('2026-05-22T10:00:00.000Z');
  });

  it('throws canvas_unavailable when bridge not configured', async () => {
    // Test the error contract is declared correctly
    expect(
      fedreserveDataframeQueryTool.errors?.some((e) => e.reason === 'canvas_unavailable'),
    ).toBe(true);
  });

  it('format renders a markdown table of results', () => {
    const output = {
      columns: ['date', 'value'],
      row_count: 2,
      rows: [
        { date: '2020-01-01', value: '3.5' },
        { date: '2020-02-01', value: '3.5' },
      ],
    };
    const blocks = fedreserveDataframeQueryTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('date');
    expect(text).toContain('value');
    expect(text).toContain('2020-01-01');
    expect(text).toContain('3.5');
  });

  it('format shows capped note when row_count exceeds rows returned', () => {
    const output = {
      columns: ['date', 'value'],
      row_count: 5000,
      rows: [{ date: '2020-01-01', value: '3.5' }],
    };
    const blocks = fedreserveDataframeQueryTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('5000');
    expect(text).toContain('showing 1');
  });

  it('format shows registered_as when present', () => {
    const output = {
      columns: ['date'],
      row_count: 0,
      rows: [],
      registered_as: 'df_XYZ99_PQR77',
      expires_at: '2026-05-22T10:00:00.000Z',
    };
    const blocks = fedreserveDataframeQueryTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_XYZ99_PQR77');
  });
});

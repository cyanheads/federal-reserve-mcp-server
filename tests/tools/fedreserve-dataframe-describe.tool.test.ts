/**
 * @fileoverview Tests for the fedreserve_dataframe_describe tool.
 * @module tests/tools/fedreserve-dataframe-describe.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fedreserveDataframeDescribeTool } from '@/mcp-server/tools/definitions/fedreserve-dataframe-describe.tool.js';

const mockDescribe = vi.fn();

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: () => ({ describe: mockDescribe }),
}));

const SAMPLE_META = {
  tableName: 'df_ABC12_DEF34',
  sourceTool: 'fedreserve_get_observations',
  queryParams: { series_ids: ['UNRATE'], observation_start: '2020-01-01' },
  createdAt: '2026-05-21T10:00:00.000Z',
  expiresAt: '2026-05-22T10:00:00.000Z',
  rowCount: 75,
  truncated: false,
  maxRows: undefined,
  columnSchema: [
    { name: 'series_id', type: 'VARCHAR', nullable: true },
    { name: 'date', type: 'VARCHAR', nullable: true },
    { name: 'value', type: 'VARCHAR', nullable: true },
  ],
};

describe('fedreserveDataframeDescribeTool', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext({ errors: fedreserveDataframeDescribeTool.errors });
    mockDescribe.mockReset();
  });

  it('lists all dataframes when no name filter provided', async () => {
    mockDescribe.mockResolvedValueOnce([SAMPLE_META]);

    const input = fedreserveDataframeDescribeTool.input.parse({});
    const result = await fedreserveDataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(1);
    expect(result.dataframes[0]).toMatchObject({
      name: 'df_ABC12_DEF34',
      source_tool: 'fedreserve_get_observations',
      row_count: 75,
      truncated: false,
    });
    expect(result.dataframes[0]?.column_schema).toHaveLength(3);
  });

  it('returns empty array when no dataframes are active', async () => {
    mockDescribe.mockResolvedValueOnce([]);

    const input = fedreserveDataframeDescribeTool.input.parse({});
    const result = await fedreserveDataframeDescribeTool.handler(input, ctx);

    expect(result.dataframes).toHaveLength(0);
  });

  it('format shows table name, row count, and columns', () => {
    const output = {
      dataframes: [
        {
          name: 'df_ABC12_DEF34',
          source_tool: 'fedreserve_get_observations',
          query_params: { series_ids: ['UNRATE'] },
          created_at: '2026-05-21T10:00:00.000Z',
          expires_at: '2026-05-22T10:00:00.000Z',
          row_count: 75,
          truncated: false,
          column_schema: [{ name: 'value', type: 'VARCHAR', nullable: true }],
        },
      ],
    };
    const blocks = fedreserveDataframeDescribeTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_ABC12_DEF34');
    expect(text).toContain('75');
    expect(text).toContain('fedreserve_get_observations');
  });

  it('format shows "No active dataframes" for empty result', () => {
    const blocks = fedreserveDataframeDescribeTool.format!({ dataframes: [] });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No active dataframes');
  });
});

it('has canvas_unavailable declared in errors', () => {
  expect(
    fedreserveDataframeDescribeTool.errors?.some((e) => e.reason === 'canvas_unavailable'),
  ).toBe(true);
});

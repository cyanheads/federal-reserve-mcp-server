/**
 * @fileoverview Tests for the fedreserve_dataframe_drop tool definition.
 * @module tests/tools/fedreserve-dataframe-drop.tool.test
 */

import type { HandlerContext, ReasonOf } from '@cyanheads/mcp-ts-core';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFedreserveDataframeDropTool,
  fedreserveDataframeDropToolDef,
} from '@/mcp-server/tools/definitions/fedreserve-dataframe-drop.tool.js';

const mockDrop = vi.fn();

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: () => ({ drop: mockDrop }),
}));

describe('fedreserveDataframeDropToolDef', () => {
  let ctx: HandlerContext<ReasonOf<typeof fedreserveDataframeDropToolDef.errors>>;

  beforeEach(() => {
    ctx = createMockContext({ errors: fedreserveDataframeDropToolDef.errors });
    mockDrop.mockReset();
  });

  it('drops an existing dataframe and returns dropped: true', async () => {
    mockDrop.mockResolvedValueOnce(true);

    const input = fedreserveDataframeDropToolDef.input.parse({ name: 'df_ABC12_DEF34' });
    const result = await fedreserveDataframeDropToolDef.handler(input, ctx);

    expect(result.dropped).toBe(true);
    expect(result.name).toBe('df_ABC12_DEF34');
  });

  it('returns dropped: false when the dataframe does not exist (idempotent)', async () => {
    mockDrop.mockResolvedValueOnce(false);

    const input = fedreserveDataframeDropToolDef.input.parse({ name: 'df_NOTEXIST_XXXXX' });
    const result = await fedreserveDataframeDropToolDef.handler(input, ctx);

    expect(result.dropped).toBe(false);
    expect(result.name).toBe('df_NOTEXIST_XXXXX');
  });

  it('has canvas_unavailable declared in errors', () => {
    expect(
      fedreserveDataframeDropToolDef.errors?.some((e) => e.reason === 'canvas_unavailable'),
    ).toBe(true);
  });

  it('format reports dropped: true with the table name', () => {
    const blocks = fedreserveDataframeDropToolDef.format!({
      dropped: true,
      name: 'df_ABC12_DEF34',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_ABC12_DEF34');
    expect(text).toContain('Dropped');
  });

  it('format reports not-found message when dropped: false', () => {
    const blocks = fedreserveDataframeDropToolDef.format!({
      dropped: false,
      name: 'df_NOTEXIST_XXXXX',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_NOTEXIST_XXXXX');
    expect(text).toContain('not found');
  });
});

describe('buildFedreserveDataframeDropTool', () => {
  it('returns the enabled tool when enabled=true', () => {
    const built = buildFedreserveDataframeDropTool(true);
    expect(built).toBe(fedreserveDataframeDropToolDef);
  });

  it('returns a disabled tool wrapper when enabled=false', () => {
    const built = buildFedreserveDataframeDropTool(false);
    expect(built).not.toBe(fedreserveDataframeDropToolDef);
    // disabled tools still carry the name
    expect(built.name).toBe('fedreserve_dataframe_drop');
  });
});

/**
 * @fileoverview Tests for the fred_dataframe_drop tool definition.
 * @module tests/tools/fred-dataframe-drop.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFredDataframeDropTool,
  fredDataframeDropToolDef,
} from '@/mcp-server/tools/definitions/fred-dataframe-drop.tool.js';

const mockDrop = vi.fn();

vi.mock('@/services/canvas-bridge/canvas-bridge.js', () => ({
  getCanvasBridge: () => ({ drop: mockDrop }),
}));

describe('fredDataframeDropToolDef', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext({ errors: fredDataframeDropToolDef.errors });
    mockDrop.mockReset();
  });

  it('drops an existing dataframe and returns dropped: true', async () => {
    mockDrop.mockResolvedValueOnce(true);

    const input = fredDataframeDropToolDef.input.parse({ name: 'df_ABC12_DEF34' });
    const result = await fredDataframeDropToolDef.handler(input, ctx);

    expect(result.dropped).toBe(true);
    expect(result.name).toBe('df_ABC12_DEF34');
  });

  it('returns dropped: false when the dataframe does not exist (idempotent)', async () => {
    mockDrop.mockResolvedValueOnce(false);

    const input = fredDataframeDropToolDef.input.parse({ name: 'df_NOTEXIST_XXXXX' });
    const result = await fredDataframeDropToolDef.handler(input, ctx);

    expect(result.dropped).toBe(false);
    expect(result.name).toBe('df_NOTEXIST_XXXXX');
  });

  it('has canvas_unavailable declared in errors', () => {
    expect(fredDataframeDropToolDef.errors?.some((e) => e.reason === 'canvas_unavailable')).toBe(
      true,
    );
  });

  it('format reports dropped: true with the table name', () => {
    const blocks = fredDataframeDropToolDef.format!({ dropped: true, name: 'df_ABC12_DEF34' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_ABC12_DEF34');
    expect(text).toContain('Dropped');
  });

  it('format reports not-found message when dropped: false', () => {
    const blocks = fredDataframeDropToolDef.format!({ dropped: false, name: 'df_NOTEXIST_XXXXX' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('df_NOTEXIST_XXXXX');
    expect(text).toContain('not found');
  });
});

describe('buildFredDataframeDropTool', () => {
  it('returns the enabled tool when enabled=true', () => {
    const built = buildFredDataframeDropTool(true);
    expect(built).toBe(fredDataframeDropToolDef);
  });

  it('returns a disabled tool wrapper when enabled=false', () => {
    const built = buildFredDataframeDropTool(false);
    expect(built).not.toBe(fredDataframeDropToolDef);
    // disabled tools still carry the name
    expect(built.name).toBe('fred_dataframe_drop');
  });
});

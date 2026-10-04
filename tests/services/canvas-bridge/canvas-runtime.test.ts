/**
 * @fileoverview Exercise the installed DuckDB provider through the FRED canvas bridge.
 * @module tests/services/canvas-bridge/canvas-runtime.test
 */

import {
  CanvasRegistry,
  DataCanvas,
  DEFAULT_CANVAS_REGISTRY_OPTIONS,
  DuckdbProvider,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetServerConfig } from '@/config/server-config.js';
import { fedreserveDataframeDescribeTool } from '@/mcp-server/tools/definitions/fedreserve-dataframe-describe.tool.js';
import {
  buildFedreserveDataframeDropTool,
  fedreserveDataframeDropToolDef,
} from '@/mcp-server/tools/definitions/fedreserve-dataframe-drop.tool.js';
import { fedreserveDataframeQueryTool } from '@/mcp-server/tools/definitions/fedreserve-dataframe-query.tool.js';
import { fedreserveGetObservationsTool } from '@/mcp-server/tools/definitions/fedreserve-get-observations.tool.js';
import { getCanvasBridge, initCanvasBridge } from '@/services/canvas-bridge/canvas-bridge.js';
import { initFredApiService } from '@/services/fred/fred-service.js';

describe('installed canvas runtime', () => {
  let canvas: DataCanvas;
  const ctx = () => createMockContext({ errors: fedreserveDataframeQueryTool.errors });

  beforeEach(() => {
    vi.stubEnv('FRED_API_KEY', 'test-key');
    vi.stubEnv('FRED_BASE_URL', 'https://fred.example.test');
    resetServerConfig();
    initFredApiService();
    const provider = new DuckdbProvider({
      defaultRowLimit: 1000,
      memoryLimitMb: 64,
      schemaSniffRows: 100,
      exportRootPath: '.cache/canvas-test-exports',
    });
    canvas = new DataCanvas(
      provider,
      new CanvasRegistry(provider, { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 }),
    );
    initCanvasBridge(canvas);
  });

  afterEach(async () => {
    initCanvasBridge(undefined);
    await canvas.shutdown(ctx());
    resetServerConfig();
    vi.unstubAllEnvs();
  });

  it('registers, describes, queries, and drops observation strings using the production dependency', async () => {
    const context = ctx();
    const registered = await getCanvasBridge()!.registerDataframe(context, {
      rows: [
        { series_id: 'UNRATE', date: '2020-01-01', value: '3.50' },
        { series_id: 'UNRATE', date: '2020-02-01', value: '.' },
      ],
      sourceTool: 'fedreserve_get_observations',
      queryParams: { series_ids: ['UNRATE'] },
    });
    expect(registered, 'DuckDB must be available in a normal install').toBeDefined();
    const name = registered!.tableName;
    const described = await fedreserveDataframeDescribeTool.handler({ name }, context);
    expect(fedreserveDataframeDescribeTool.output.parse(described).dataframes).toMatchObject([
      {
        name,
        row_count: 2,
        column_schema: expect.arrayContaining([{ name: 'value', type: 'VARCHAR', nullable: true }]),
      },
    ]);
    expect(fedreserveDataframeDescribeTool.format!(described)).toEqual([
      expect.objectContaining({ text: expect.stringContaining(name) }),
    ]);

    const queried = await fedreserveDataframeQueryTool.handler(
      fedreserveDataframeQueryTool.input.parse({
        sql: `SELECT date, value FROM ${name} ORDER BY date`,
      }),
      context,
    );
    expect(fedreserveDataframeQueryTool.output.parse(queried).rows).toEqual([
      { date: '2020-01-01', value: '3.50' },
      { date: '2020-02-01', value: '.' },
    ]);
    expect(fedreserveDataframeQueryTool.format!(queried)).toEqual([
      expect.objectContaining({ text: expect.stringContaining('| 2020-01-01 | 3.50 |') }),
    ]);

    const dropped = await buildFedreserveDataframeDropTool(true).handler({ name }, context);
    expect(dropped).toEqual({ name, dropped: true });
    expect(fedreserveDataframeDropToolDef.format!(dropped)).toEqual([
      expect.objectContaining({ text: expect.stringContaining(name) }),
    ]);
    await expect(fedreserveDataframeDropToolDef.handler({ name }, context)).resolves.toEqual({
      name,
      dropped: false,
    });
    await expect(getCanvasBridge()!.describe(context, name)).resolves.toEqual([]);
    await expect(getCanvasBridge()!.query(context, `SELECT * FROM ${name}`)).rejects.toMatchObject({
      data: { reason: 'missing_table', recovery: { hint: expect.any(String) } },
    });
  });

  it('preserves the disabled drop card and its activation hint', () => {
    const disabled = buildFedreserveDataframeDropTool(false);
    expect(disabled.name).toBe('fedreserve_dataframe_drop');
    expect(JSON.stringify(disabled)).toContain('FRED_DATAFRAME_DROP_ENABLED=true');
  });

  it.each([500, 501])(
    'keeps %i observations accessible across the spill boundary',
    async (count) => {
      const observations = Array.from({ length: count }, (_, index) => ({
        date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
        value: index === 0 ? '3.50' : '.',
      }));
      const http = createFetchMock([
        {
          match: /^https:\/\/fred\.example\.test\/series\/observations\?/,
          respond: Response.json({
            observation_start: '2020-01-01',
            observation_end: observations.at(-1)!.date,
            units: 'lin',
            observations,
          }),
        },
      ]);
      http.install();
      try {
        const result = await runToolContract(fedreserveGetObservationsTool, {
          series_ids: 'UNRATE',
        });
        expect(result.isError).toBeFalsy();
        const output = fedreserveGetObservationsTool.output.parse(result.structuredContent);
        expect(output.total_observations).toBe(count);
        expect(output.series[0]?.observations).toHaveLength(count > 500 ? 20 : count);
        expect(output.series[0]?.observations[0]?.value).toBe('3.50');
        expect(JSON.stringify(result.content)).toContain('3.50');
        if (count > 500) {
          expect(output.dataset).toMatchObject({
            row_count: count,
            preview_rows: 20,
            truncated: false,
          });
          expect(JSON.stringify(result.content)).toContain(output.dataset!.name);
        } else expect(output.dataset).toBeUndefined();
        expect(http.calls).toHaveLength(1);
      } finally {
        http.restore();
      }
    },
  );

  it('returns inline multi-series observations when canvas is disabled', async () => {
    initCanvasBridge(undefined);
    const http = createFetchMock([
      {
        match: /^https:\/\/fred\.example\.test\/series\/observations\?/,
        respond: Response.json({
          observation_start: '2020-01-01',
          observation_end: '2020-01-01',
          units: 'lin',
          observations: [{ date: '2020-01-01', value: '3.50' }],
        }),
      },
    ]);
    http.install();
    try {
      const result = await runToolContract(fedreserveGetObservationsTool, {
        series_ids: ['UNRATE', 'FEDFUNDS'],
      });
      expect(result.isError).toBeFalsy();
      const output = fedreserveGetObservationsTool.output.parse(result.structuredContent);
      expect(output.dataset).toBeUndefined();
      expect(output.series).toHaveLength(2);
      expect(output.series.every((series) => series.observations[0]?.value === '3.50')).toBe(true);
      expect(JSON.stringify(result.content)).toContain('3.50');
      expect(JSON.stringify(result.content)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect(http.calls).toHaveLength(2);
    } finally {
      http.restore();
    }
  });

  it('keeps SQL rejection recovery without allowing writes or catalog discovery', async () => {
    for (const [sql, reason] of [
      ['SELECT * FROM information_schema.tables', 'system_catalog_access'],
      ['CREATE TABLE forbidden (value INTEGER)', 'non_select_statement'],
    ]) {
      const result = await runToolContract(fedreserveDataframeQueryTool, { sql: sql! });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: expect.any(String) } } },
      });
      expect(JSON.stringify(result.content)).toContain('Recovery:');
    }
  });

  it('returns the declared canvas-unavailable recovery on both error surfaces', async () => {
    initCanvasBridge(undefined);
    const result = await runToolContract(fedreserveDataframeQueryTool, { sql: 'SELECT 1' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(JSON.stringify(result.content)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  });
});

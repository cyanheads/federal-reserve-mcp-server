/**
 * @fileoverview Exercise the installed DuckDB provider through the FRED canvas bridge.
 * @module tests/services/canvas-bridge/canvas-runtime.test
 */

import { z } from '@cyanheads/mcp-ts-core';
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

  it('creates fresh tables on independent spills without changing previous rows', async () => {
    const http = createFetchMock([
      {
        match: /^https:\/\/fred\.example\.test\/series\/observations\?/,
        respond: Response.json({
          units: 'lin',
          observations: [{ date: '2024-01-01', value: '1.00' }],
        }),
      },
    ]);
    http.install();
    try {
      const context = createMockContext({ errors: fedreserveGetObservationsTool.errors });
      const input = fedreserveGetObservationsTool.input.parse({
        series_ids: ['UNRATE', 'FEDFUNDS'],
      });
      const first = await fedreserveGetObservationsTool.handler(input, context);
      const second = await fedreserveGetObservationsTool.handler(input, context);
      const one = fedreserveGetObservationsTool.output.parse(first).dataset!;
      const two = fedreserveGetObservationsTool.output.parse(second).dataset!;
      expect(one.name).not.toBe(two.name);
      for (const name of [one.name, two.name]) {
        const { result } = await getCanvasBridge()!.query(context, `SELECT * FROM ${name}`);
        expect(result.rows).toHaveLength(2);
        expect(result.rows.every((row) => row.value === '1.00')).toBe(true);
      }
    } finally {
      http.restore();
    }
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
            observation_start: '1600-01-01',
            observation_end: '9999-12-31',
            units: 'lin',
            observations,
          }),
        },
      ]);
      http.install();
      try {
        const state = ctx().state;
        const observationsTool: typeof fedreserveGetObservationsTool = {
          ...fedreserveGetObservationsTool,
          handler: (input, context) =>
            fedreserveGetObservationsTool.handler(input, { ...context, state }),
        };
        const describeTool: typeof fedreserveDataframeDescribeTool = {
          ...fedreserveDataframeDescribeTool,
          handler: (input, context) =>
            fedreserveDataframeDescribeTool.handler(input, { ...context, state }),
        };
        const queryTool: typeof fedreserveDataframeQueryTool = {
          ...fedreserveDataframeQueryTool,
          handler: (input, context) =>
            fedreserveDataframeQueryTool.handler(input, { ...context, state }),
        };
        const result = await runToolContract(observationsTool, {
          series_ids: 'UNRATE',
        });
        expect(result.isError).toBeFalsy();
        const output = fedreserveGetObservationsTool.output.parse(result.structuredContent);
        expect(output.total_observations).toBe(count);
        expect(output.series[0]).toMatchObject({
          observation_start: '2020-01-01',
          observation_end: observations.at(-1)!.date,
          observation_count: count,
        });
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
          const { notice } = z.object({ notice: z.string() }).parse(result.structuredContent);
          expect(notice).toContain(output.dataset!.name);
          expect(notice).toContain(`${count} rows`);
          expect(notice).toContain('20 rows inline');
          expect(notice).toContain(
            `fedreserve_dataframe_describe with ${JSON.stringify({ name: output.dataset!.name })}`,
          );
          expect(notice).toContain(`SELECT * FROM ${output.dataset!.name}`);
          expect(result.content.at(-1)).toMatchObject({ text: expect.stringContaining(notice) });
          const described = await runToolContract(describeTool, { name: output.dataset!.name });
          expect(described.structuredContent).toMatchObject({
            dataframes: [
              {
                name: output.dataset!.name,
                row_count: count,
                column_schema: expect.arrayContaining([
                  { name: 'value', type: 'VARCHAR', nullable: true },
                ]),
              },
            ],
          });
          const queried = await runToolContract(queryTool, {
            sql: `SELECT * FROM ${output.dataset!.name}`,
            preview: 1000,
          });
          expect(queried.isError).toBeFalsy();
          expect(
            fedreserveDataframeQueryTool.output.parse(queried.structuredContent).rows,
          ).toHaveLength(count);
        } else {
          expect(output.dataset).toBeUndefined();
          expect(result.structuredContent).not.toHaveProperty('notice');
        }
        expect(http.calls).toHaveLength(1);
      } finally {
        http.restore();
      }
    },
  );

  it.each([false, true])(
    'reports the actual total preview after registration (failure=%s)',
    async (failed) => {
      const http = createFetchMock([
        {
          match: /^https:\/\/fred\.example\.test\/series\/observations\?/,
          respond: Response.json({
            units: 'lin',
            observations: [{ date: '2024-01-01', value: '1.00' }],
          }),
        },
      ]);
      const registration = failed
        ? vi.spyOn(canvas, 'acquire').mockRejectedValue(new Error('Unavailable'))
        : undefined;
      http.install();
      try {
        const result = await runToolContract(fedreserveGetObservationsTool, {
          series_ids: ['UNRATE', 'FEDFUNDS'],
        });
        expect(result.isError).toBeFalsy();
        const output = fedreserveGetObservationsTool.output.parse(result.structuredContent);
        expect(output.series.flatMap((series) => series.observations)).toHaveLength(2);
        if (failed) {
          expect(output.dataset).toBeUndefined();
          expect(result.structuredContent).not.toHaveProperty('notice');
          expect(output.message).toContain('up to 20 rows inline');
          expect(output.message).not.toContain('per series');
        } else {
          expect(output.dataset?.preview_rows).toBe(2);
          const { notice } = z.object({ notice: z.string() }).parse(result.structuredContent);
          expect(notice).toContain('2 rows inline');
          expect(result.content.at(-1)).toMatchObject({ text: expect.stringContaining(notice) });
        }
      } finally {
        http.restore();
        registration?.mockRestore();
      }
    },
  );

  it('keeps a 20-row total budget and fetched counts when registration fails', async () => {
    const http = createFetchMock([
      {
        match: /^https:\/\/fred\.example\.test\/series\/observations\?/,
        respond: Response.json({
          units: 'lin',
          observations: Array.from({ length: 60 }, (_, index) => ({
            date: '2024-01-01',
            value: String(index),
          })),
        }),
      },
    ]);
    const registration = vi.spyOn(canvas, 'acquire').mockRejectedValue(new Error('Unavailable'));
    http.install();
    try {
      const result = await runToolContract(fedreserveGetObservationsTool, {
        series_ids: ['UNRATE', 'FEDFUNDS'],
      });
      const output = fedreserveGetObservationsTool.output.parse(result.structuredContent);
      expect(output.series.map((series) => series.observations.length)).toEqual([10, 10]);
      expect(output.series.map((series) => series.observation_count)).toEqual([60, 60]);
      expect(output.total_observations).toBe(120);
      expect(result.structuredContent).not.toHaveProperty('notice');
    } finally {
      http.restore();
      registration.mockRestore();
    }
  });

  it('does not turn cancellation during failed registration into inline success', async () => {
    const controller = new AbortController();
    const http = createFetchMock([
      {
        match: /^https:\/\/fred\.example\.test\/series\/observations\?/,
        respond: Response.json({
          units: 'lin',
          observations: [{ date: '2024-01-01', value: '1.00' }],
        }),
      },
    ]);
    const registration = vi.spyOn(canvas, 'acquire').mockImplementation(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    http.install();
    try {
      const result = await runToolContract(
        fedreserveGetObservationsTool,
        { series_ids: ['UNRATE', 'FEDFUNDS'] },
        { context: { signal: controller.signal } },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
      expect(JSON.stringify(result.content)).toMatch(/abort|cancel/i);
      expect(registration).toHaveBeenCalledTimes(1);
    } finally {
      http.restore();
      registration.mockRestore();
    }
  });

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

  it('preserves provider counts across previews, caps, empty pages, and chained dataframes', async () => {
    const context = ctx();
    const state = context.state;
    const registered = await getCanvasBridge()!.registerDataframe(context, {
      rows: Array.from({ length: 12 }, (_, i) => ({ i })),
      sourceTool: 'fedreserve_get_observations',
      queryParams: {},
    });
    expect(registered).toBeDefined();
    const name = registered!.tableName;
    const queryTool: typeof fedreserveDataframeQueryTool = {
      ...fedreserveDataframeQueryTool,
      handler: (args, context) => fedreserveDataframeQueryTool.handler(args, { ...context, state }),
    };
    const query = (input: z.input<typeof queryTool.input>) => runToolContract(queryTool, input);
    const cases = [
      { input: { sql: `SELECT i FROM ${name}`, preview: 2, row_limit: 20 }, count: 12, length: 2 },
      { input: { sql: `SELECT i FROM ${name}`, preview: 2, row_limit: 4 }, count: 4, length: 2 },
      { input: { sql: `SELECT i FROM ${name} LIMIT 2 OFFSET 20` }, count: 0, length: 0 },
      {
        input: {
          sql: `SELECT i FROM ${name}`,
          register_as: 'df_FIRST_TABLE',
          preview: 2,
          row_limit: 4,
        },
        count: 12,
        length: 2,
      },
      {
        input: {
          sql: 'SELECT i FROM df_FIRST_TABLE WHERE i >= 3',
          register_as: 'df_NEXT1_TABLE',
          preview: 1,
          row_limit: 4,
        },
        count: 9,
        length: 1,
      },
      {
        input: { sql: 'SELECT i FROM df_NEXT1_TABLE WHERE i >= 8', preview: 2, row_limit: 3 },
        count: 3,
        length: 2,
      },
    ];
    for (const { input, count, length } of cases) {
      const result = await query(input);
      expect(result.isError, JSON.stringify({ input, result })).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ row_count: count, totalCount: count });
      expect(fedreserveDataframeQueryTool.output.parse(result.structuredContent).rows).toHaveLength(
        length,
      );
      expect(result.content.at(-1)).toMatchObject({
        text: expect.stringContaining(`${count} total`),
      });
    }
    const invalid = await query({ sql: 'SELECT 1', row_limit: 10001 });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(JSON.stringify(invalid.content)).toContain('row_limit');
  });

  it('returns the declared canvas-unavailable recovery on both error surfaces', async () => {
    initCanvasBridge(undefined);
    const result = await runToolContract(fedreserveDataframeQueryTool, { sql: 'SELECT 1' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(JSON.stringify(result.content)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  });
});

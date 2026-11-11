/**
 * @fileoverview Exercise the installed DuckDB provider through the FRED canvas bridge.
 * @module tests/services/canvas-bridge/canvas-runtime.test
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
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

const seriesMetadataRoute = {
  match: /^https:\/\/fred\.example\.test\/series\?/,
  respond: () => Response.json({ seriess: [] }),
};

describe('installed canvas runtime', () => {
  let canvas: DataCanvas;
  let registryClockMs: number;
  const ctx = () => createMockContext({ errors: fedreserveDataframeQueryTool.errors });

  beforeEach(() => {
    vi.stubEnv('FRED_API_KEY', 'test-key');
    vi.stubEnv('FRED_BASE_URL', 'https://fred.example.test');
    resetServerConfig();
    initFredApiService();
    registryClockMs = Date.now();
    const provider = new DuckdbProvider({
      defaultRowLimit: 1000,
      memoryLimitMb: 64,
      schemaSniffRows: 100,
      exportRootPath: '.cache/canvas-test-exports',
    });
    canvas = new DataCanvas(
      provider,
      new CanvasRegistry(
        provider,
        { ...DEFAULT_CANVAS_REGISTRY_OPTIONS, sweeperIntervalMs: 0 },
        () => registryClockMs,
      ),
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
      seriesMetadataRoute,
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
        seriesMetadataRoute,
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
        const firstInline = count > 500 ? observations[count - 20] : observations[0];
        expect(output.series[0]?.observations[0]).toMatchObject(firstInline!);
        expect(JSON.stringify(result.content)).toContain(firstInline!.date);
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
          const { rows } = fedreserveDataframeQueryTool.output.parse(queried.structuredContent);
          expect(rows).toHaveLength(count);
          expect(rows).toContainEqual(
            expect.objectContaining({ date: '2020-01-01', value: '3.50' }),
          );
        } else {
          expect(output.dataset).toBeUndefined();
          expect(result.structuredContent).not.toHaveProperty('notice');
        }
        expect(http.calls.map(({ request }) => new URL(request.url).pathname).sort()).toEqual([
          '/series',
          '/series/observations',
        ]);
      } finally {
        http.restore();
      }
    },
  );

  it.each([false, true])(
    'reports the actual total preview after registration (failure=%s)',
    async (failed) => {
      const http = createFetchMock([
        seriesMetadataRoute,
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
          expect(output.message).toBe(
            'Canvas registration failed. Showing all 2 fetched observations inline.',
          );
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
      seriesMetadataRoute,
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
      seriesMetadataRoute,
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

  it.each([false, true])(
    'removes staged observations when the provenance write fails (cancelled=%s)',
    async (cancelled) => {
      const context = ctx();
      const instance = await canvas.acquireShared(context);
      const controller = new AbortController();
      const write = vi.spyOn(context.state, 'set').mockImplementationOnce(async () => {
        if (cancelled) controller.abort();
        throw new Error('State store unavailable');
      });
      const observationTool: typeof fedreserveGetObservationsTool = {
        ...fedreserveGetObservationsTool,
        handler: (input, request) =>
          fedreserveGetObservationsTool.handler(input, { ...request, state: context.state }),
      };
      const http = createFetchMock([
        seriesMetadataRoute,
        {
          match: /^https:\/\/fred\.example\.test\/series\/observations\?/,
          respond: () =>
            Response.json({
              units: 'lin',
              observations: [{ date: '2024-01-01', value: '1.00' }],
            }),
        },
      ]);
      http.install();
      try {
        const result = await runToolContract(
          observationTool,
          { series_ids: ['UNRATE', 'FEDFUNDS'] },
          { context: { signal: controller.signal } },
        );
        const content = JSON.stringify(result.content);
        if (cancelled) {
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toMatchObject({ error: { code: -32011 } });
          expect(content).toMatch(/abort|cancel/i);
        } else {
          expect(result.isError).toBeFalsy();
          expect(result.structuredContent).toMatchObject({
            total_observations: 2,
            message: 'Canvas registration failed. Showing all 2 fetched observations inline.',
          });
          expect(result.structuredContent).not.toHaveProperty('dataset');
          expect(content).toContain('Showing all 2 fetched observations inline');
          expect(content).toContain('1.00');
        }
        expect(write).toHaveBeenCalledOnce();
        await expect(getCanvasBridge()!.describe(context)).resolves.toEqual([]);
        await expect(instance.describe()).resolves.toEqual([]);
      } finally {
        http.restore();
        write.mockRestore();
      }
    },
  );

  it('returns inline multi-series observations when canvas is disabled', async () => {
    initCanvasBridge(undefined);
    const http = createFetchMock([
      seriesMetadataRoute,
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
      expect(output.message).toBe(
        'Canvas is unavailable. Showing all 2 fetched observations inline.',
      );
      expect(JSON.stringify(result.content)).toContain(output.message);
      expect(http.calls.map(({ request }) => new URL(request.url).pathname).sort()).toEqual([
        '/series',
        '/series',
        '/series/observations',
        '/series/observations',
      ]);
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
      {
        input: { sql: `SELECT i FROM ${name}`, preview: 2, row_limit: 4 },
        count: 4,
        length: 2,
        truncated: true,
      },
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
        input: { sql: 'SELECT i FROM df_NEXT1_TABLE WHERE i >= 9', preview: 2, row_limit: 3 },
        count: 3,
        length: 2,
      },
    ];
    for (const { input, count, length, truncated } of cases) {
      const result = await query(input);
      expect(result.isError, JSON.stringify({ input, result })).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ row_count: count });
      expect(fedreserveDataframeQueryTool.output.parse(result.structuredContent).rows).toHaveLength(
        length,
      );
      const content = JSON.stringify(result.content);
      if (truncated) {
        expect(result.structuredContent).toHaveProperty('truncated', true);
        expect(result.structuredContent).not.toHaveProperty('totalCount');
        expect(content).toContain('capped at 4');
        expect(content).toContain('register_as');
        expect(content).not.toContain('4 total');
      } else {
        expect(result.structuredContent).not.toHaveProperty('truncated');
        expect(result.structuredContent).toHaveProperty('totalCount', count);
        expect(content).toContain(`${count} total`);
      }
    }
    const invalid = await query({ sql: 'SELECT 1', row_limit: 10001 });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: { code: -32602 } });
    expect(JSON.stringify(invalid.content)).toContain('row_limit');
  });

  it('describes typed NULLs, empty tables, and chained columns from DuckDB', async () => {
    const state = ctx().state;
    const queryTool: typeof fedreserveDataframeQueryTool = {
      ...fedreserveDataframeQueryTool,
      handler: (args, context) => fedreserveDataframeQueryTool.handler(args, { ...context, state }),
    };
    const describeTool: typeof fedreserveDataframeDescribeTool = {
      ...fedreserveDataframeDescribeTool,
      handler: (args, context) =>
        fedreserveDataframeDescribeTool.handler(args, { ...context, state }),
    };
    const typed = [
      { name: 'v', type: 'DOUBLE', nullable: true },
      { name: 'amount', type: 'DECIMAL(10,2)', nullable: true },
    ];
    const projection = 'SELECT CAST(NULL AS DOUBLE) AS v, CAST(1.2 AS DECIMAL(10,2)) AS amount';
    for (const { sql, name, columns, count } of [
      { sql: projection, name: 'df_TYPED_00001', columns: typed, count: 1 },
      { sql: `${projection} WHERE FALSE`, name: 'df_EMPTY_00001', columns: typed, count: 0 },
      {
        sql: 'SELECT v, amount, CAST(1 AS BIGINT) AS n FROM df_TYPED_00001',
        name: 'df_CHAIN_00001',
        columns: [...typed, { name: 'n', type: 'BIGINT', nullable: true }],
        count: 1,
      },
    ]) {
      const registered = await runToolContract(queryTool, { sql, register_as: name, preview: 0 });
      expect(registered.structuredContent).toMatchObject({
        registered_as: name,
        row_count: count,
        rows: [],
        totalCount: count,
      });
      const described = await runToolContract(describeTool, { name });
      expect(described.structuredContent).toMatchObject({
        dataframes: [{ name, column_schema: columns }],
      });
      for (const column of columns)
        expect(JSON.stringify(described.content)).toContain(column.type);
    }
  });

  it('keeps SQL NULL distinct from empty text and text null in a capped result', async () => {
    const result = await runToolContract(fedreserveDataframeQueryTool, {
      sql: "SELECT CAST(NULL AS VARCHAR) AS a, '' AS b, 'null' AS c FROM range(2)",
      row_limit: 1,
    });
    const [block] = result.content;
    expect(result.structuredContent).toMatchObject({
      truncated: true,
      rows: [{ a: null, b: '', c: 'null' }],
    });
    expect(block?.type).toBe('text');
    const text = block?.type === 'text' ? block.text : '';
    expect(text).toMatch(/^```json\n/);
    expect(text).toContain('Result capped at 1 row');
    expect(text).toContain('register_as');
    expect(JSON.parse(text.slice(8, text.lastIndexOf('```')))).toEqual(
      fedreserveDataframeQueryTool.output.parse(result.structuredContent),
    );
  });

  it('removes a registered query table when its provenance cannot be saved', async () => {
    const bridge = getCanvasBridge()!;
    const context = ctx();
    await bridge.query(context, 'SELECT 1');
    const error = new Error('State store unavailable');
    vi.spyOn(context.state, 'set').mockRejectedValueOnce(error);
    const name = 'df_UNSAV_00001';
    await expect(bridge.query(context, 'SELECT 1 AS v', { registerAs: name })).rejects.toBe(error);
    await expect(bridge.describe(context)).resolves.toEqual([]);
    await expect(bridge.query(context, `SELECT * FROM ${name}`)).rejects.toMatchObject({
      data: { reason: 'missing_table' },
    });
  });

  it('stages concurrent first registrations on one canvas per tenant', async () => {
    const bridge = getCanvasBridge()!;
    const tenant = ctx();
    const otherTenant = createMockContext({ tenantId: 'other' });
    const stage = (context: Context, value: string) =>
      bridge.registerDataframe(context, {
        rows: [{ value }],
        queryParams: {},
        sourceTool: 'fedreserve_get_observations',
      });
    const values = ['first', 'second', 'third', 'fourth', 'fifth'];
    const [registrations, other] = await Promise.all([
      Promise.all(values.map((value) => stage(tenant, value))),
      stage(otherTenant, 'other'),
    ]);
    expect(canvas.countForTenant(tenant)).toBe(1);
    expect(canvas.countForTenant(otherTenant)).toBe(1);
    expect((await bridge.describe(tenant)).map((entry) => entry.tableName)).toEqual(
      expect.arrayContaining(registrations.map((entry) => entry!.tableName)),
    );
    const results = await Promise.all(
      registrations.map((entry) => bridge.query(tenant, `SELECT value FROM ${entry!.tableName}`)),
    );
    expect(results.map(({ result }) => result.rows)).toEqual(values.map((value) => [{ value }]));
    await expect(bridge.describe(otherTenant)).resolves.toMatchObject([
      { tableName: other!.tableName },
    ]);
    await expect(
      bridge.query(otherTenant, `SELECT * FROM ${registrations[0]!.tableName}`),
    ).rejects.toMatchObject({ data: { reason: 'missing_table' } });
  });

  it.each(['describe', 'drop', 'replace'] as const)(
    'purges stale provenance during %s without minting for reads',
    async (operation) => {
      const bridge = getCanvasBridge()!;
      const context = ctx();
      const initial = await bridge.registerDataframe(context, {
        rows: [{ v: 1 }],
        queryParams: {},
        sourceTool: 'fedreserve_get_observations',
      });
      const name = initial!.tableName;
      registryClockMs += DEFAULT_CANVAS_REGISTRY_OPTIONS.ttlMs + 1;
      const before = canvas.countForTenant(context);
      if (operation === 'describe') {
        await expect(bridge.describe(context)).resolves.toEqual([]);
        expect(canvas.countForTenant(context)).toBe(before);
      } else if (operation === 'drop') {
        await expect(bridge.drop(context, name)).resolves.toBe(false);
        expect(canvas.countForTenant(context)).toBe(before);
      } else {
        // The state's own TTL can elapse before the next request observes a dead ID.
        const stale = await context.state.get(`df-meta/${name}`);
        await context.state.delete('canvas-id');
        for (let i = 0; i < 100; i++) await context.state.set(`df-meta/stale-${i}`, stale);
        const replacement = await bridge.query(context, 'SELECT 1 AS v', {
          registerAs: 'df_NEW01_00001',
        });
        expect(replacement.meta?.tableName).toBe('df_NEW01_00001');
        await expect(bridge.describe(context)).resolves.toMatchObject([
          { tableName: 'df_NEW01_00001' },
        ]);
        expect((await context.state.list('df-meta/')).items).toHaveLength(1);
      }
      await expect(context.state.get(`df-meta/${name}`)).resolves.toBeNull();
    },
  );

  it('cancels a caller queued behind replacement without minting another canvas', async () => {
    const bridge = getCanvasBridge()!;
    const context = ctx();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const list = context.state.list.bind(context.state);
    vi.spyOn(context.state, 'list').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return list(...args);
    });
    const first = bridge.query(context, 'SELECT 1 AS v', { registerAs: 'df_FIRST_00001' });
    const controller = new AbortController();
    const reason = new Error('Request cancelled');
    try {
      await entered.promise;
      const queued = bridge.query({ ...context, signal: controller.signal }, 'SELECT 2 AS v');
      const cancelled = expect(queued).rejects.toBe(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort(reason);
      await cancelled;
      expect(canvas.countForTenant(context)).toBe(0);
    } finally {
      release.resolve();
      await first;
    }
    expect(canvas.countForTenant(context)).toBe(1);
    await expect(bridge.describe(context)).resolves.toMatchObject([
      { tableName: 'df_FIRST_00001' },
    ]);
  });

  it('returns the declared canvas-unavailable recovery on both error surfaces', async () => {
    initCanvasBridge(undefined);
    const result = await runToolContract(fedreserveDataframeQueryTool, { sql: 'SELECT 1' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    expect(JSON.stringify(result.content)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  });
});

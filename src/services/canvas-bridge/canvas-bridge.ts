/**
 * @fileoverview Adapter between the FRED tools and the framework DataCanvas
 * primitive. Holds one shared canvas per tenant, generates `df_XXXXX_XXXXX`
 * table names, derives all-nullable schemas (FRED observation values are strings
 * and can be "." for missing data — NOT NULL would trip the appender), tracks
 * per-table TTL + provenance in `ctx.state`, and lazy-sweeps expired tables on
 * every public op. Best-effort: failed canvas operations log a warning and
 * return `undefined`/empty so the caller's inline response remains useful.
 * @module services/canvas-bridge/canvas-bridge
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  assertNoSystemCatalogs,
  type CanvasInstance,
  type ColumnSchema,
  type DataCanvas,
  inferSchemaFromRows,
  type QueryResult,
} from '@cyanheads/mcp-ts-core/canvas';
import { databaseError } from '@cyanheads/mcp-ts-core/errors';
import { idGenerator } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

/** Per-table provenance + TTL metadata persisted in `ctx.state`. */
export interface DataframeMeta {
  columnSchema: (Omit<ColumnSchema, 'type'> & { type: string })[];
  createdAt: string;
  expiresAt: string;
  maxRows: number | undefined;
  queryParams: Record<string, unknown>;
  rowCount: number;
  sourceTool: string;
  tableName: string;
  truncated: boolean;
}

export interface RegisterDataframeResult {
  columnSchema: ColumnSchema[];
  expiresAt: string;
  rowCount: number;
  tableName: string;
}

export function toDatasetField(registered: RegisterDataframeResult): {
  name: string;
  row_count: number;
  expires_at: string;
} {
  return {
    name: registered.tableName,
    row_count: registered.rowCount,
    expires_at: registered.expiresAt,
  };
}

export interface RegisterDataframeOptions {
  maxRows?: number;
  queryParams: Record<string, unknown>;
  rows: Record<string, unknown>[];
  sourceTool: string;
  truncated?: boolean;
}

export interface BridgeQueryOptions {
  preview?: number;
  queryParams?: Record<string, unknown>;
  registerAs?: string;
  rowLimit?: number;
  sourceTool?: string;
}

const META_PREFIX = 'df-meta/';
const TABLE_NAME_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Infer column schema from rows. FRED observation values are strings and can be
 * "." for missing; all columns are nullable (framework `inferSchemaFromRows`
 * always emits `nullable: true` as of mcp-ts-core 0.10.4).
 */
export function deriveAllNullableSchema(rows: Record<string, unknown>[]): ColumnSchema[] {
  return inferSchemaFromRows(rows);
}

export class CanvasBridge {
  constructor(private readonly canvas: DataCanvas) {}

  /**
   * Persist a row set as `df_<id>` on the tenant's shared canvas. Returns
   * `undefined` on a canvas failure so callers can surface their inline
   * response without leaking infrastructure errors.
   */
  async registerDataframe(
    ctx: Context,
    options: RegisterDataframeOptions,
  ): Promise<RegisterDataframeResult | undefined> {
    if (options.rows.length === 0) {
      ctx.log.debug('Skipping dataframe registration — no rows', {
        sourceTool: options.sourceTool,
      });
      return;
    }

    try {
      const instance = await this.canvas.acquireShared(ctx, this.sharedCanvasOptions(ctx));
      await this.sweepExpired(ctx, instance);
      const tableName = this.mintTableName();
      const schema = deriveAllNullableSchema(options.rows);

      const result = await instance.registerTable(tableName, options.rows, {
        schema,
        signal: ctx.signal,
      });

      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      const meta: DataframeMeta = {
        tableName: result.tableName,
        sourceTool: options.sourceTool,
        queryParams: options.queryParams,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        rowCount: result.rowCount,
        truncated: options.truncated ?? false,
        maxRows: options.maxRows,
        columnSchema: schema,
      };
      try {
        await ctx.state.set(`${META_PREFIX}${result.tableName}`, meta);
      } catch (error) {
        await this.dropUntrackedTable(ctx, instance, result.tableName);
        throw error;
      }

      ctx.log.info('Dataframe registered', {
        tableName: result.tableName,
        rowCount: result.rowCount,
        sourceTool: options.sourceTool,
      });

      return {
        tableName: result.tableName,
        rowCount: result.rowCount,
        expiresAt: meta.expiresAt,
        columnSchema: schema,
      };
    } catch (error) {
      ctx.signal.throwIfAborted();
      ctx.log.warning('Dataframe registration failed', {
        error: error instanceof Error ? error.message : String(error),
        sourceTool: options.sourceTool,
      });
      return;
    }
  }

  /** List dataframes with provenance. Sweeps expired tables first. */
  async describe(ctx: Context, tableName?: string): Promise<DataframeMeta[]> {
    const instance = await this.canvas.acquireShared(ctx, {
      ...this.sharedCanvasOptions(ctx),
      create: false,
    });
    if (!instance) return [];
    await this.sweepExpired(ctx, instance);
    if (tableName) {
      const meta = await ctx.state.get<DataframeMeta>(`${META_PREFIX}${tableName}`);
      return meta ? [meta] : [];
    }
    const entries: DataframeMeta[] = [];
    for await (const { meta } of this.iterateMeta(ctx)) entries.push(meta);
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Run a SELECT against the shared canvas. Bridge additionally rejects
   * system-catalog access before handing SQL to the framework gate. Optional
   * `registerAs` chains the result as a new dataframe with a fresh per-table TTL.
   */
  async query(
    ctx: Context,
    sql: string,
    options: BridgeQueryOptions = {},
  ): Promise<{ result: QueryResult; meta?: DataframeMeta }> {
    assertNoSystemCatalogs(sql);
    const instance = await this.canvas.acquireShared(ctx, this.sharedCanvasOptions(ctx));
    await this.sweepExpired(ctx, instance);

    const registerAs = options.registerAs;
    const result = await instance.query(sql, {
      ...(options.preview !== undefined && { preview: options.preview }),
      ...(options.rowLimit !== undefined && { rowLimit: options.rowLimit }),
      ...(registerAs !== undefined && { registerAs }),
      signal: ctx.signal,
    });

    const { tableName } = result;
    if (!tableName) return { result };

    try {
      const [table] = await instance.describe({
        kind: 'table',
        tableName,
        signal: ctx.signal,
      });
      if (!table) throw databaseError('Registered dataframe is missing from the canvas.');
      const now = Date.now();
      const ttlMs = getServerConfig().datasetTtlSeconds * 1000;
      const meta: DataframeMeta = {
        tableName,
        sourceTool: options.sourceTool ?? 'fedreserve_dataframe_query',
        queryParams: options.queryParams ?? { sql },
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        rowCount: result.rowCount,
        truncated: false,
        maxRows: undefined,
        columnSchema: table.columns.map(({ name, engineType, type, nullable }) => ({
          name,
          type: engineType ?? type,
          ...(nullable !== undefined && { nullable }),
        })),
      };
      await ctx.state.set(`${META_PREFIX}${tableName}`, meta);
      return { result, meta };
    } catch (error) {
      await this.dropUntrackedTable(ctx, instance, tableName);
      throw error;
    }
  }

  /** Remove a committed table whose provenance could not be recorded. */
  private async dropUntrackedTable(
    ctx: Context,
    instance: CanvasInstance,
    tableName: string,
  ): Promise<void> {
    try {
      await instance.drop(tableName);
    } catch (error) {
      ctx.log.warning('Failed to remove dataframe after metadata registration failed', {
        tableName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Idempotent drop. Removes the table from the canvas and the metadata
   * entry from `ctx.state`. Returns true when found and removed, false when absent.
   */
  async drop(ctx: Context, tableName: string): Promise<boolean> {
    const instance = await this.canvas.acquireShared(ctx, {
      ...this.sharedCanvasOptions(ctx),
      create: false,
    });
    if (!instance) return false;
    await this.sweepExpired(ctx, instance);
    const metaKey = `${META_PREFIX}${tableName}`;
    const hadMeta = (await ctx.state.get(metaKey)) !== null;
    await ctx.state.delete(metaKey);

    try {
      const dropped = await instance.drop(tableName);
      return dropped || hadMeta;
    } catch (error) {
      ctx.signal.throwIfAborted();
      ctx.log.warning('Canvas drop failed', {
        tableName,
        error: error instanceof Error ? error.message : String(error),
      });
      return hadMeta;
    }
  }

  /** Sweep expired tables. Best-effort — failure on one table doesn't stop others. */
  private async sweepExpired(ctx: Context, instance: CanvasInstance): Promise<void> {
    const nowIso = new Date().toISOString();
    for await (const { key, meta } of this.iterateMeta(ctx)) {
      if (meta.expiresAt > nowIso) continue;

      ctx.signal.throwIfAborted();
      try {
        await instance.drop(meta.tableName);
      } catch (error) {
        ctx.signal.throwIfAborted();
        ctx.log.warning('TTL sweep drop failed', {
          tableName: meta.tableName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await ctx.state.delete(key);
      ctx.log.debug('Expired dataframe swept', {
        tableName: meta.tableName,
        expiredAt: meta.expiresAt,
      });
    }
  }

  /** Cursor-paged scan of metadata entries. */
  private async *iterateMeta(ctx: Context): AsyncGenerator<{ key: string; meta: DataframeMeta }> {
    let cursor: string | undefined;
    do {
      const page = await ctx.state.list(META_PREFIX, {
        ...(cursor !== undefined && { cursor }),
        limit: 100,
      });
      for (const item of page.items) {
        if (item.value) yield { key: item.key, meta: item.value as DataframeMeta };
      }
      cursor = page.cursor;
    } while (cursor);
  }

  /** Purge the tenant's provenance while shared-canvas replacement is serialized. */
  private sharedCanvasOptions(ctx: Context) {
    return {
      onReplace: async () => {
        for await (const { key } of this.iterateMeta(ctx)) await ctx.state.delete(key);
      },
    };
  }

  private mintTableName(): string {
    const left = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    const right = idGenerator.generateRandomString(5, TABLE_NAME_CHARSET);
    return `df_${left}_${right}`;
  }
}

let _bridge: CanvasBridge | undefined;

/**
 * Wire the canvas bridge during `setup()`. `canvas` is `undefined` when
 * `CANVAS_PROVIDER_TYPE` is `none` (`src/index.ts` defaults it to `duckdb`) or
 * the server runs on Workers.
 * Tools that materialize dataframes call `getCanvasBridge()` and skip
 * materialization when the bridge is absent.
 */
export function initCanvasBridge(canvas: DataCanvas | undefined): void {
  _bridge = canvas ? new CanvasBridge(canvas) : undefined;
}

export function getCanvasBridge(): CanvasBridge | undefined {
  return _bridge;
}

/**
 * @fileoverview Tests for the system-catalog SQL gate denial logic. Uses the
 * framework's `assertNoSystemCatalogs` from `@cyanheads/mcp-ts-core/canvas`,
 * which replaced the former local `sql-gate-extras.ts` implementation.
 * @module tests/services/canvas-bridge/sql-gate-extras.test
 */

import { assertNoSystemCatalogs } from '@cyanheads/mcp-ts-core/canvas';
import { describe, expect, it } from 'vitest';

describe('assertNoSystemCatalogs', () => {
  it('passes clean SELECT statements', () => {
    expect(() => assertNoSystemCatalogs('SELECT date, value FROM df_ABC12_DEF34')).not.toThrow();
    expect(() =>
      assertNoSystemCatalogs("SELECT * FROM df_XYZ99_PQR77 WHERE series_id = 'UNRATE'"),
    ).not.toThrow();
  });

  it('rejects information_schema references', () => {
    expect(() => assertNoSystemCatalogs('SELECT * FROM information_schema.tables')).toThrow(
      'system catalog',
    );
  });

  it('rejects pg_catalog references', () => {
    expect(() => assertNoSystemCatalogs('SELECT * FROM pg_catalog.pg_tables')).toThrow(
      'system catalog',
    );
  });

  it('rejects sqlite_master references', () => {
    expect(() => assertNoSystemCatalogs('SELECT * FROM sqlite_master')).toThrow('system catalog');
  });

  it('rejects duckdb_* catalog references', () => {
    expect(() => assertNoSystemCatalogs('SELECT * FROM duckdb_tables()')).toThrow('system catalog');
    expect(() => assertNoSystemCatalogs('SELECT * FROM duckdb_views()')).toThrow('system catalog');
  });

  it('does not trip on catalog tokens inside single-quoted string literals', () => {
    // Single-quoted strings are stripped before pattern matching
    expect(() =>
      assertNoSystemCatalogs("SELECT 'information_schema' AS label FROM df_ABC12_DEF34"),
    ).not.toThrow();
  });

  it('rejects double-quoted catalog references (quoted identifiers)', () => {
    // In DuckDB, double quotes denote identifiers, not string literals.
    // "pg_catalog" is a catalog reference — correctly rejected.
    expect(() => assertNoSystemCatalogs('SELECT "pg_catalog" AS note FROM df_ABC12_DEF34')).toThrow(
      'system catalog',
    );
  });

  it('is case-insensitive', () => {
    expect(() => assertNoSystemCatalogs('SELECT * FROM INFORMATION_SCHEMA.tables')).toThrow(
      'system catalog',
    );
  });
});

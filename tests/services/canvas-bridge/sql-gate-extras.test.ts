/**
 * @fileoverview Tests for the system-catalog SQL gate denial logic.
 * @module tests/services/canvas-bridge/sql-gate-extras.test
 */

import { describe, expect, it } from 'vitest';
import { assertNoSystemCatalogAccess } from '@/services/canvas-bridge/sql-gate-extras.js';

describe('assertNoSystemCatalogAccess', () => {
  it('passes clean SELECT statements', () => {
    expect(() =>
      assertNoSystemCatalogAccess('SELECT date, value FROM df_ABC12_DEF34'),
    ).not.toThrow();
    expect(() =>
      assertNoSystemCatalogAccess("SELECT * FROM df_XYZ99_PQR77 WHERE series_id = 'UNRATE'"),
    ).not.toThrow();
  });

  it('rejects information_schema references', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM information_schema.tables')).toThrow(
      'denied system catalog',
    );
  });

  it('rejects pg_catalog references', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM pg_catalog.pg_tables')).toThrow(
      'denied system catalog',
    );
  });

  it('rejects sqlite_master references', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM sqlite_master')).toThrow(
      'denied system catalog',
    );
  });

  it('rejects duckdb_* catalog references', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM duckdb_tables()')).toThrow(
      'denied system catalog',
    );
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM duckdb_views()')).toThrow(
      'denied system catalog',
    );
  });

  it('does not trip on catalog tokens inside string literals', () => {
    expect(() =>
      assertNoSystemCatalogAccess("SELECT 'information_schema' AS label FROM df_ABC12_DEF34"),
    ).not.toThrow();
    expect(() =>
      assertNoSystemCatalogAccess('SELECT "pg_catalog" AS note FROM df_ABC12_DEF34'),
    ).not.toThrow();
  });

  it('is case-insensitive', () => {
    expect(() => assertNoSystemCatalogAccess('SELECT * FROM INFORMATION_SCHEMA.tables')).toThrow(
      'denied system catalog',
    );
  });
});

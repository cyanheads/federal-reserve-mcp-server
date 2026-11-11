/**
 * @fileoverview Canonical FRED IDs and explicit batch deferral for series tools.
 * @module mcp-server/tools/prepare-series-batch
 */
import type { HandlerContext } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';

const deferredSeries = createCounter(
  'mcp.fred.series.deferred',
  'Series IDs deferred by a batch processing limit',
  '{ids}',
);

/** Normalize IDs before applying a tool's workload limit; rejects empty or oversized input. */
export function prepareSeriesBatch(
  input: string | string[],
  processingLimit: 10 | 50,
  clampLimits: boolean,
  ctx: HandlerContext<'invalid_series_ids'>,
): { ids: string[]; deferredIds: string[] } {
  const supplied = (Array.isArray(input) ? input : [input])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);
  const acceptedLimit = clampLimits ? 100 : processingLimit;
  if (supplied.length === 0 || supplied.length > acceptedLimit) {
    throw ctx.fail(
      'invalid_series_ids',
      `Supply between 1 and ${acceptedLimit} nonempty series IDs, separated by commas or in an array.`,
      { limit: acceptedLimit },
    );
  }
  const unique = [...new Set(supplied)];
  const ids = unique.slice(0, processingLimit);
  const deferredIds = unique.slice(processingLimit);
  if (deferredIds.length > 0) {
    ctx.log.info('FRED series batch deferred IDs', {
      processed: ids.length,
      deferred: deferredIds.length,
    });
    deferredSeries.add(deferredIds.length, { processing_limit: processingLimit });
  }
  return { ids, deferredIds };
}

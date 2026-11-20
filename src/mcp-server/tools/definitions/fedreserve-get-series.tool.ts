/**
 * @fileoverview Retrieve metadata for one or more FRED series — title, units,
 * frequency, seasonal adjustment, observation range, popularity, and optional
 * notes, tags, and release mapping.
 * Returns partial success when some IDs fail.
 * @module mcp-server/tools/definitions/fedreserve-get-series
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';
import { prepareSeriesBatch } from '@/mcp-server/tools/prepare-series-batch.js';
import { FredDomainError } from '@/services/fred/fred-error.js';
import { getFredApiService } from '@/services/fred/fred-service.js';

const OPTIONAL_LOOKUP_ERRORS = new Set([
  JsonRpcErrorCode.NotFound,
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.RateLimited,
  JsonRpcErrorCode.Timeout,
  JsonRpcErrorCode.Unauthorized,
  JsonRpcErrorCode.Forbidden,
  JsonRpcErrorCode.SerializationError,
]);

const SeriesMetaSchema = z.object({
  id: z.string().describe('FRED series ID.'),
  title: z.string().describe('Series title.'),
  units: z.string().describe('Units of measurement.'),
  frequency: z.string().describe('Data frequency.'),
  seasonal_adjustment: z.string().describe('Seasonal adjustment status.'),
  last_updated: z.string().describe('ISO 8601 last update date.'),
  observation_start: z.string().optional().describe('Earliest available observation date.'),
  observation_end: z.string().optional().describe('Latest available observation date.'),
  popularity: z.number().optional().describe('Popularity score (0–100) when provided.'),
  notes: z
    .string()
    .optional()
    .describe('Full FRED notes when include_notes is true and notes exist.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Exact FRED tag names when include_tags is true and the lookup succeeds.'),
  release: z
    .object({
      id: z.number().describe('Release ID accepted by fedreserve_get_release.'),
      name: z.string().describe('FRED release name.'),
    })
    .optional()
    .describe('Series release when include_release is true and the lookup succeeds.'),
});

const SeriesReleaseEnvelope = z.object({
  releases: z.array(SeriesMetaSchema.shape.release.unwrap()),
});

function optionalLookupResult<T>(result: PromiseSettledResult<T>): T | undefined {
  if (result.status === 'fulfilled') return result.value;
  const error: unknown = result.reason;
  if (!(error instanceof McpError) || !OPTIONAL_LOOKUP_ERRORS.has(error.code)) throw error;
  return undefined;
}

/** Build the advertised batch limit from the startup configuration. */
export function buildFedreserveGetSeriesTool(clampLimits: boolean) {
  return tool('fedreserve_get_series', {
    title: 'Get FRED Series Metadata',
    description:
      'Retrieve FRED series metadata: title, units, frequency, seasonal adjustment, range, and popularity. Process up to 50 normalized IDs per call; deferred_ids lists remaining IDs. Request notes for methodology and source terms, tags for fedreserve_search_series, or release mapping for fedreserve_get_release. Returns partial success when some IDs fail.',
    annotations: { readOnlyHint: true, openWorldHint: true },

    errors: [
      {
        reason: 'series_not_found',
        code: JsonRpcErrorCode.NotFound,
        when: 'A series ID exists in format but FRED returns no data for it.',
        recovery: 'Verify the series ID is correct using fedreserve_search_series and try again.',
      },
      {
        reason: 'invalid_series_ids',
        code: JsonRpcErrorCode.ValidationError,
        when: 'No nonempty series IDs remain after normalization, or the accepted batch limit is exceeded.',
        recovery:
          'Supply nonempty FRED IDs as a comma-separated string or array within the advertised batch limit.',
        thrownBy: 'service',
      },
      {
        reason: 'partial_failure',
        code: JsonRpcErrorCode.ServiceUnavailable,
        when: 'Every processed ID in a multi-series batch failed.',
        recovery: 'Check the failed array for per-ID errors and retry failed IDs individually.',
      },
    ],

    input: z.object({
      series_ids: z
        .union([
          z.string().min(1).describe('One ID or comma-separated IDs (e.g., "UNRATE,GDP").'),
          z
            .array(z.string())
            .min(1)
            .max(clampLimits ? 100 : 50)
            .describe('Series IDs; comma-separated entries are accepted.'),
        ])
        .describe(
          clampLimits
            ? 'Up to 100 IDs; trimmed, uppercased and deduplicated. Process the first 50 and return the rest in deferred_ids.'
            : 'Up to 50 IDs; trimmed, uppercased and deduplicated.',
        ),
      include_release: z
        .boolean()
        .default(false)
        .describe(
          'Resolve each successful series to its release ID and name; adds at most one bounded request per series.',
        ),
      include_notes: z
        .boolean()
        .default(false)
        .describe(
          'Include the full FRED series notes when available. Request these before reusing data to review methodology, source codes, citations, and licensing terms.',
        ),
      include_tags: z
        .boolean()
        .default(false)
        .describe(
          'Return exact FRED tag names for the tag_names filter on fedreserve_search_series; adds at most one bounded request per resolved series.',
        ),
    }),

    /** FRED's own `/series` parameter is the singular `series_id`. */
    inputAliases: { series_id: 'series_ids' },

    output: z.object({
      series: z
        .array(SeriesMetaSchema.describe('Metadata for one FRED series.'))
        .describe('Successfully resolved series metadata.'),
      failed: z
        .array(
          z
            .object({
              id: z.string().describe('Series ID that failed.'),
              error: z.string().describe('Error message.'),
            })
            .describe('A failed series fetch with its error.'),
        )
        .describe('Series IDs that could not be resolved, with per-ID error details.'),
      deferred_ids: z
        .array(z.string().describe('Normalized series ID to request next.'))
        .optional()
        .describe('Unprocessed IDs beyond the 50-ID processing limit.'),
    }),

    enrichment: {
      notice: z
        .string()
        .optional()
        .describe('Series IDs whose optional release or tag lookups are unavailable.'),
    },

    async handler(input, ctx) {
      const { ids, deferredIds } = prepareSeriesBatch(input.series_ids, 50, clampLimits, ctx);
      ctx.log.info('fedreserve_get_series', { count: ids.length });

      const fred = getFredApiService();
      const results = await Promise.allSettled(ids.map((id) => fred.getSeriesById(id, ctx)));
      ctx.signal.throwIfAborted();

      const series: z.infer<typeof SeriesMetaSchema>[] = [];
      const failed: { id: string; error: string }[] = [];

      for (const [i, result] of results.entries()) {
        const id = ids[i];
        if (id === undefined) {
          throw internalError(`Positional mismatch between series_ids and settled results at ${i}`);
        }
        if (result.status === 'rejected') {
          const error: unknown = result.reason;
          if (
            error instanceof Error &&
            (error.name === 'AbortError' ||
              (error instanceof McpError && error.code === JsonRpcErrorCode.RequestCancelled))
          )
            throw error;
          if (ids.length === 1) {
            if (error instanceof FredDomainError && error.reason === 'series_not_found') {
              throw ctx.fail('series_not_found', error.message);
            }
            throw error;
          }
          failed.push({ id, error: error instanceof Error ? error.message : String(error) });
          continue;
        }

        const raw = result.value.seriess?.[0];
        if (!raw) {
          const error = `Series ${id} not found on FRED.`;
          if (ids.length === 1) throw ctx.fail('series_not_found', error);
          failed.push({ id, error });
          continue;
        }
        const notes = input.include_notes ? raw.notes : undefined;
        series.push({
          id: raw.id,
          title: raw.title ?? '',
          units: raw.units ?? '',
          frequency: raw.frequency ?? '',
          seasonal_adjustment: raw.seasonal_adjustment ?? '',
          last_updated: raw.last_updated ?? '',
          ...(raw.observation_start && { observation_start: raw.observation_start }),
          ...(raw.observation_end && { observation_end: raw.observation_end }),
          ...(typeof raw.popularity === 'number' && { popularity: raw.popularity }),
          ...(notes?.trim() && { notes }),
        });
      }

      if (series.length === 0 && failed.length > 0) {
        const details = failed.map(({ id, error }) => `${id}: ${error}`).join('\n');
        const deferredDetails =
          deferredIds.length > 0 ? `\nDeferred IDs: ${deferredIds.join(', ')}.` : '';
        throw ctx.fail(
          'partial_failure',
          `All ${ids.length} processed series failed.\n${details}${deferredDetails}`,
          {
            failed,
            ...(deferredIds.length > 0 && { deferred_ids: deferredIds }),
          },
        );
      }

      if (input.include_release || input.include_tags) {
        const lookups = await Promise.all(
          series.map(async (entry) => ({
            entry,
            results: await Promise.allSettled([
              input.include_release ? fred.getSeriesRelease(entry.id, ctx) : undefined,
              input.include_tags ? fred.getSeriesTags(entry.id, ctx) : undefined,
            ]),
          })),
        );
        ctx.signal.throwIfAborted();
        const releasesUnavailable: string[] = [];
        const tagsUnavailable: string[] = [];
        for (const {
          entry,
          results: [releaseResult, tagResult],
        } of lookups) {
          if (input.include_release) {
            const release = SeriesReleaseEnvelope.safeParse(optionalLookupResult(releaseResult))
              .data?.releases[0];
            if (release) entry.release = release;
            else releasesUnavailable.push(entry.id);
          }
          if (input.include_tags) {
            const tags = optionalLookupResult(tagResult);
            if (tags) entry.tags = tags;
            else tagsUnavailable.push(entry.id);
          }
        }
        const notices: string[] = [];
        if (releasesUnavailable.length > 0)
          notices.push(
            `Release mapping unavailable for ${releasesUnavailable.join(', ')}; series metadata is complete.`,
          );
        if (tagsUnavailable.length > 0)
          notices.push(
            `Tags unavailable for ${tagsUnavailable.join(', ')}; series metadata is complete.`,
          );
        if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
      }
      return { series, failed, ...(deferredIds.length > 0 && { deferred_ids: deferredIds }) };
    },

    format: (result) => {
      const lines: string[] = [];
      for (const s of result.series) {
        const title = `${escapeMarkdownInline(s.id)}: ${escapeMarkdownInline(s.title)}`;
        lines.push(title.includes('\n') ? title : `### ${title}`);
        lines.push(
          `**Units:** ${escapeMarkdownInline(s.units)} | **Frequency:** ${escapeMarkdownInline(s.frequency)} | **Seasonal adj.:** ${escapeMarkdownInline(s.seasonal_adjustment)}`,
        );
        if (s.observation_start || s.observation_end) {
          lines.push(
            `**Range:** ${escapeMarkdownInline(s.observation_start ?? '?')} → ${escapeMarkdownInline(s.observation_end ?? '?')}`,
          );
        }
        lines.push(
          `**Last updated:** ${escapeMarkdownInline(s.last_updated)}${s.popularity !== undefined ? ` | **Popularity:** ${s.popularity}` : ''}`,
        );
        if (s.notes) {
          // CommonMark normalizes carriage returns and replaces NULs.
          if (s.notes.includes('\r') || s.notes.includes('\0')) {
            lines.push('**Notes:**', markdown().codeBlock(JSON.stringify(s.notes), 'json').build());
          } else {
            lines.push(`> ${escapeMarkdownInline(s.notes)}`);
          }
        }
        if (s.tags) {
          if (s.tags.length === 0) lines.push('**Tags:** None.');
          else lines.push('**Tags:**', ...s.tags.map((tag) => `- ${escapeMarkdownInline(tag)}`));
        }
        if (s.release)
          lines.push(
            `**Release:** ${s.release.id} — ${escapeMarkdownInline(s.release.name)}. Use this ID with fedreserve_get_release.`,
          );
        lines.push('');
      }
      if (result.failed.length > 0) {
        lines.push(`**${result.failed.length} failed:**`);
        for (const f of result.failed) {
          lines.push(`- ${escapeMarkdownInline(f.id)}: ${escapeMarkdownInline(f.error)}`);
        }
      }
      if (result.deferred_ids?.length)
        lines.push(
          `**Deferred IDs:** ${result.deferred_ids.map(escapeMarkdownInline).join(', ')}. Request these IDs in the next call.`,
        );
      return [{ type: 'text', text: lines.join('\n').trimEnd() }];
    },
  });
}

/** Default batch policy; startup uses the configured factory. */
export const fedreserveGetSeriesTool = buildFedreserveGetSeriesTool(true);

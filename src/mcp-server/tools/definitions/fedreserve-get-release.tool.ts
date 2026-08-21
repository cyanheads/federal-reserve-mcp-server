/**
 * @fileoverview Return metadata and associated series for a FRED release.
 * Accepts a `release_id` integer or a `release_search` text query.
 * @module mcp-server/tools/definitions/fedreserve-get-release
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFredApiService } from '@/services/fred/fred-service.js';
import type { FredReleaseResponse } from '@/services/fred/types.js';

export const fedreserveGetReleaseTool = tool('fedreserve_get_release', {
  title: 'Get FRED Release',
  description:
    'Return metadata and associated series for a FRED release (e.g., Employment Situation, Consumer Price Index). Accepts a release_id integer or a release_search text query — release_search performs a substring match across all FRED releases; prefer release_id when you know the ID. Returns release name, link, scheduled dates, and a paginated list of its series. Provide exactly one of release_id or release_search.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'missing_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither release_id nor release_search was provided, or both were provided.',
      recovery:
        'Supply release_id (integer) or release_search (substring) — not both, not neither.',
    },
    {
      reason: 'release_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'release_id not found, or release_search matched no releases.',
      recovery: 'Try a broader search term or verify the release_id using the FRED website.',
    },
    {
      reason: 'ambiguous_release_search',
      code: JsonRpcErrorCode.ValidationError,
      when: 'release_search matched multiple releases with similar names.',
      recovery: 'Narrow the search term or use release_id for an exact match.',
    },
  ],

  input: z.object({
    release_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Numeric FRED release ID. Provide this or release_search — not both.'),
    release_search: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring to match against release names. Provide this or release_id — not both.',
      ),
    series_limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Max series to return for this release (default 20).'),
    series_offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Pagination offset for the series list.'),
  }),

  output: z.object({
    release: z
      .object({
        id: z.number().describe('FRED release ID.'),
        name: z.string().describe('Release name.'),
        press_release: z.boolean().optional().describe('True when FRED links to a press release.'),
        link: z.string().optional().describe('URL to the release press release when available.'),
        notes: z.string().optional().describe('Release notes when provided.'),
      })
      .describe('Release metadata.'),
    scheduled_dates: z
      .array(z.string())
      .describe('Upcoming release dates (ISO 8601). May be empty when not yet scheduled.'),
    series_count: z.number().describe('Total series count for this release.'),
    series_offset: z.number().describe('Pagination offset applied.'),
    series: z
      .array(
        z
          .object({
            id: z.string().describe('Series ID.'),
            title: z.string().describe('Series title.'),
            units: z.string().describe('Units of measurement.'),
            frequency: z.string().describe('Data frequency.'),
            seasonal_adjustment: z.string().describe('Seasonal adjustment status.'),
            last_updated: z.string().describe('ISO 8601 last update date.'),
          })
          .describe('One series belonging to this release.'),
      )
      .describe('Series belonging to this release (paginated).'),
    search_alternatives: z
      .array(
        z
          .object({
            id: z.number().describe('Release ID.'),
            name: z.string().describe('Release name.'),
          })
          .describe('An alternative matching release.'),
      )
      .optional()
      .describe(
        'Other releases that matched the search when ambiguous_release_search was triggered. Use one of these IDs with release_id for an exact match.',
      ),
  }),

  enrichment: {
    totalCount: z
      .number()
      .describe('Total series count for this release before pagination was applied.'),
  },

  async handler(input, ctx) {
    const hasId = input.release_id !== undefined;
    const hasSearch = (input.release_search?.trim().length ?? 0) > 0;

    if (!hasId && !hasSearch) {
      throw ctx.fail('missing_input', 'Provide either release_id or release_search.', {
        ...ctx.recoveryFor('missing_input'),
      });
    }

    if (hasId && hasSearch) {
      throw ctx.fail('missing_input', 'Provide release_id or release_search, not both.', {
        ...ctx.recoveryFor('missing_input'),
      });
    }

    let releaseId: number;

    if (input.release_id !== undefined) {
      releaseId = input.release_id;
      ctx.log.info('fedreserve_get_release by id', { release_id: releaseId });
    } else if (input.release_search !== undefined) {
      const searchTerm = input.release_search.trim().toLowerCase();
      ctx.log.info('fedreserve_get_release by search', { term: searchTerm });

      const allResp = await getFredApiService().getAllReleases(ctx);
      const matches = (allResp.releases ?? []).filter((r) =>
        r.name.toLowerCase().includes(searchTerm),
      );

      const firstMatch = matches[0];
      if (!firstMatch) {
        throw ctx.fail('release_not_found', `No FRED releases matched "${input.release_search}".`, {
          ...ctx.recoveryFor('release_not_found'),
        });
      }

      const exact =
        matches.length > 1 ? matches.find((r) => r.name.toLowerCase() === searchTerm) : undefined;

      if (matches.length === 1 || exact) {
        releaseId = (exact ?? firstMatch).id;
      } else {
        const alternatives = matches.slice(0, 10).map((r) => ({ id: r.id, name: r.name }));
        const altList = alternatives.map((a) => `  - ${a.name} (ID: ${a.id})`).join('\n');
        throw ctx.fail(
          'ambiguous_release_search',
          `"${input.release_search}" matched ${matches.length} releases. Use release_id for an exact match.\n\nMatching releases:\n${altList}`,
          {
            ...ctx.recoveryFor('ambiguous_release_search'),
            search_alternatives: alternatives,
          },
        );
      }
    } else {
      // Unreachable — the missing_input guards above ensure exactly one of
      // release_id / release_search is present.
      throw ctx.fail('missing_input', 'Provide either release_id or release_search.', {
        ...ctx.recoveryFor('missing_input'),
      });
    }

    const limit = input.series_limit ?? 20;
    const offset = input.series_offset ?? 0;

    let releaseResp: FredReleaseResponse;
    try {
      releaseResp = await getFredApiService().getRelease(releaseId, ctx);
    } catch (err) {
      const fredBody = String(
        (err != null && typeof err === 'object' && 'data' in err
          ? (err as { data?: { body?: unknown } }).data?.body
          : undefined) ?? '',
      ).toLowerCase();
      if (
        fredBody.includes('does not exist') ||
        fredBody.includes('bad request') ||
        fredBody.includes('not found')
      ) {
        throw ctx.fail('release_not_found', `Release ${releaseId} not found on FRED.`, {
          ...ctx.recoveryFor('release_not_found'),
        });
      }
      throw err;
    }

    const [seriesResp, datesResp] = await Promise.all([
      getFredApiService().getReleaseSeries({ release_id: releaseId, limit, offset }, ctx),
      getFredApiService()
        .getReleaseDates({ release_id: releaseId }, ctx)
        .catch(() => ({
          release_dates: [],
        })),
    ]);
    ctx.enrich.total(seriesResp.count ?? 0);

    const release = releaseResp.releases?.[0];
    if (!release) {
      throw ctx.fail('release_not_found', `Release ${releaseId} not found on FRED.`, {
        ...ctx.recoveryFor('release_not_found'),
      });
    }

    const scheduledDates = (datesResp.release_dates ?? [])
      .map((d) => d.date)
      .filter((d) => d >= new Date().toISOString().slice(0, 10));

    return {
      release: {
        id: release.id,
        name: release.name,
        ...(typeof release.press_release === 'boolean' && {
          press_release: release.press_release,
        }),
        ...(release.link?.trim() && { link: release.link.trim() }),
        ...(release.notes?.trim() && { notes: release.notes.trim() }),
      },
      scheduled_dates: scheduledDates,
      series_count: seriesResp.count ?? 0,
      series_offset: offset,
      series: (seriesResp.seriess ?? []).map((s) => ({
        id: s.id,
        title: s.title ?? '',
        units: s.units ?? '',
        frequency: s.frequency ?? '',
        seasonal_adjustment: s.seasonal_adjustment ?? '',
        last_updated: s.last_updated ?? '',
      })),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    const r = result.release;
    lines.push(`## Release: ${r.name} (ID: ${r.id})`);
    if (r.press_release !== undefined) {
      lines.push(`Press release: ${r.press_release ? 'Yes' : 'No'}`);
    }
    if (r.link) lines.push(`Link: ${r.link}`);
    if (r.notes) lines.push(`> ${r.notes}`);
    lines.push('');

    if (result.scheduled_dates.length > 0) {
      lines.push(`**Scheduled dates:** ${result.scheduled_dates.join(', ')}`);
    } else {
      lines.push('**Scheduled dates:** None listed');
    }
    lines.push('');

    lines.push(
      `**Series** (${result.series.length} of ${result.series_count}, offset ${result.series_offset}):`,
    );
    for (const s of result.series) {
      lines.push(
        `- **${s.id}**: ${s.title} (${s.units}, ${s.frequency}, ${s.seasonal_adjustment}, updated ${s.last_updated})`,
      );
    }

    if (result.search_alternatives && result.search_alternatives.length > 0) {
      lines.push('');
      lines.push('**Other matching releases (use release_id for exact match):**');
      for (const alt of result.search_alternatives) {
        lines.push(`- [${alt.id}] ${alt.name}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});

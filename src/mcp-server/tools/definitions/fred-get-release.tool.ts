/**
 * @fileoverview Return metadata and associated series for a FRED release.
 * Accepts a `release_id` integer or a `release_search` text query — the name
 * path fetches all releases via /fred/releases and matches client-side (FRED
 * has no server-side release search endpoint).
 * @module mcp-server/tools/definitions/fred-get-release
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getFredApiService } from '@/services/fred/fred-service.js';

export const fredGetReleaseTool = tool('fred_get_release', {
  title: 'Get FRED Release',
  description:
    'Return metadata and associated series for a FRED release (e.g., Employment Situation, Consumer Price Index). Accepts a release_id integer or a release_search text query — the name path fetches all releases via /fred/releases and matches client-side by case-insensitive substring (FRED has no server-side release search). Returns release name, link, scheduled dates, and a paginated list of its series. Provide exactly one of release_id or release_search.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
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
        'Case-insensitive substring to match against release names. Fetches all releases (~300 entries) and filters client-side. Provide this or release_id — not both.',
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

  async handler(input, ctx) {
    // Validate: exactly one of release_id or release_search required
    const hasId = input.release_id !== undefined;
    const hasSearch = input.release_search && input.release_search.trim().length > 0;

    if (!hasId && !hasSearch) {
      throw validationError('Provide either release_id or release_search.');
    }

    let releaseId: number;

    if (hasId) {
      releaseId = input.release_id!;
      ctx.log.info('fred_get_release by id', { release_id: releaseId });
    } else {
      const searchTerm = input.release_search!.trim().toLowerCase();
      ctx.log.info('fred_get_release by search', { term: searchTerm });

      const allResp = await getFredApiService().getAllReleases(ctx);
      const releases = allResp.releases ?? [];
      const matches = releases.filter((r) => r.name.toLowerCase().includes(searchTerm));

      if (matches.length === 0) {
        throw ctx.fail('release_not_found', `No FRED releases matched "${input.release_search}".`, {
          ...ctx.recoveryFor('release_not_found'),
        });
      }

      if (matches.length === 1) {
        releaseId = matches[0]!.id;
      } else {
        // Multiple matches — check if there's an exact match
        const exact = matches.find((r) => r.name.toLowerCase() === searchTerm);
        if (exact) {
          releaseId = exact.id;
        } else {
          throw ctx.fail(
            'ambiguous_release_search',
            `"${input.release_search}" matched ${matches.length} releases. Use release_id for an exact match.`,
            {
              ...ctx.recoveryFor('ambiguous_release_search'),
              search_alternatives: matches.slice(0, 10).map((r) => ({ id: r.id, name: r.name })),
            },
          );
        }
      }
    }

    const limit = input.series_limit ?? 20;
    const offset = input.series_offset ?? 0;

    const [releaseResp, seriesResp, datesResp] = await Promise.all([
      getFredApiService().getRelease(releaseId, ctx),
      getFredApiService().getReleaseSeries({ release_id: releaseId, limit, offset }, ctx),
      getFredApiService()
        .getReleaseDates({ release_id: releaseId }, ctx)
        .catch(() => ({
          release_dates: [],
        })),
    ]);

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

/**
 * @fileoverview Page the FRED calendar across all releases.
 * @module mcp-server/tools/definitions/fedreserve-list-release-dates
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getFredApiService } from '@/services/fred/fred-service.js';

export const fedreserveListReleaseDatesTool = tool('fedreserve_list_release_dates', {
  title: 'List FRED Release Dates',
  description:
    'List scheduled dates across all FRED releases in an inclusive date window, earliest first. Dates come from data publishers and can differ from when FRED makes data available. Pass a returned release_id to fedreserve_get_release for release details and series.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_date_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The effective end date precedes the start date or falls outside YYYY-MM-DD.',
      recovery: 'Supply a valid end_date on or after start_date.',
    },
  ],

  input: z.object({
    start_date: z.iso
      .date()
      .optional()
      .describe('Inclusive first date, YYYY-MM-DD. Defaults to today in UTC.'),
    end_date: z.iso
      .date()
      .optional()
      .describe(
        'Inclusive last date, YYYY-MM-DD. Defaults to seven calendar days after start_date.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(50)
      .describe('Maximum dates to return per page (default 50, maximum 1000).'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Number of dates in the window to skip. Defaults to zero.'),
  }),

  output: z.object({
    dates: z
      .array(
        z
          .object({
            date: z.iso.date().describe('Scheduled release date.'),
            release_id: z.number().int().positive().describe('Numeric FRED release ID.'),
            release_name: z.string().describe('Name of the FRED release.'),
          })
          .describe('One scheduled release.'),
      )
      .describe('Scheduled release dates on this page, earliest first.'),
    offset: z.number().int().min(0).describe('Offset applied to this page.'),
  }),

  enrichment: {
    totalCount: z.number().describe('Total scheduled releases in the date window.'),
    notice: z.string().optional().describe('Explanation when the page contains no dates.'),
  },

  async handler(input, ctx) {
    const startDate = input.start_date ?? new Date().toISOString().slice(0, 10);
    const endDate = input.end_date ?? defaultEndDate(startDate);
    if (!endDate || endDate < startDate) {
      throw ctx.fail(
        'invalid_date_window',
        'Provide a valid date window from start_date through end_date.',
      );
    }

    const page = await getFredApiService().listReleaseDates(
      {
        start_date: startDate,
        end_date: endDate,
        limit: input.limit,
        offset: input.offset,
      },
      ctx,
    );
    ctx.enrich.total(page.count);
    if (page.release_dates.length === 0) {
      ctx.enrich.notice(
        page.count === 0
          ? 'No scheduled releases in this date window.'
          : 'The offset is past the end of this date window.',
      );
    }
    return { dates: page.release_dates, offset: page.offset };
  },

  format(result) {
    const lines = [
      `**Scheduled releases** (${result.dates.length} shown, offset ${result.offset})`,
    ];
    for (const { date, release_id, release_name } of result.dates) {
      lines.push(`- ${date} · ${escapeMarkdownInline(release_name)} (ID: ${release_id})`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

function defaultEndDate(startDate: string): string | undefined {
  const date = new Date(startDate);
  date.setUTCDate(date.getUTCDate() + 7);
  const iso = date.toISOString();
  return iso.startsWith('+') ? undefined : iso.slice(0, 10);
}

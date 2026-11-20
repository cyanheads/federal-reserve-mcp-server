/**
 * @fileoverview FRED API service — wraps `api.stlouisfed.org/fred` with API key
 * injection, JSON parsing, retry with exponential backoff, and 429 rate-limit
 * detection. Single base-URL config point for staging vs. production. All public
 * methods accept `Context` for correlated logging and `AbortSignal` for
 * cancellation via `ctx.signal`.
 * @module services/fred/fred-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { serializationError, serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';
import { withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { fredHttpError } from './fred-error.js';
import type {
  FredCategoryResponse,
  FredCategorySeriesResponse,
  FredObservationsResponse,
  FredReleaseDatesResponse,
  FredReleaseResponse,
  FredReleaseSeriesResponse,
  FredReleasesResponse,
  FredSearchResponse,
  FredSeriesResponse,
} from './types.js';

export interface SearchSeriesParams {
  filter_value?: string;
  filter_variable?: 'frequency' | 'units' | 'seasonal_adjustment';
  limit?: number;
  offset?: number;
  query: string;
  search_type?: 'full_text' | 'series_id';
  tag_names?: string;
}

export interface GetObservationsParams {
  aggregation_method?: 'avg' | 'sum' | 'eop';
  frequency?: string;
  limit?: number;
  observation_end?: string;
  observation_start?: string;
  offset?: number;
  series_id: string;
  sort_order?: 'asc' | 'desc';
  units?: string;
}

export interface GetReleaseDatesParams {
  release_id: number;
}

/** Inclusive calendar window and FRED page coordinates. */
export interface ListReleaseDatesParams {
  end_date: string;
  limit: number;
  offset: number;
  start_date: string;
}

export interface GetReleaseSeriesParams {
  limit?: number;
  offset?: number;
  release_id: number;
}

export interface GetCategorySeriesParams {
  category_id: number;
  limit?: number;
  offset?: number;
}

/** Whole-exchange bound for a FRED upstream call (headers + body). */
const FRED_TIMEOUT_MS = 15_000;
const FRED_RETRY_DEADLINE_MS = 45_000;
const FRED_OPTIONAL_TIMEOUT_MS = 2_000;

const SeriesTagsEnvelope = z.object({
  tags: z.array(z.object({ name: z.string().min(1) })),
});
const ReleaseCalendarEnvelope = z.object({
  count: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(1000),
  release_dates: z.array(
    z.object({
      date: z.iso.date(),
      release_id: z.number().int().positive(),
      release_name: z.string().min(1),
    }),
  ),
});

export class FredApiService {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    const config = getServerConfig();
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  /** Search for series by full-text or series_id query. */
  searchSeries(params: SearchSeriesParams, ctx: Context): Promise<FredSearchResponse> {
    const query = new URLSearchParams({ api_key: this.apiKey, file_type: 'json' });
    query.set('search_text', params.query);
    if (params.search_type) query.set('search_type', params.search_type);
    if (params.filter_variable) query.set('filter_variable', params.filter_variable);
    if (params.filter_value) query.set('filter_value', params.filter_value);
    if (params.tag_names) query.set('tag_names', params.tag_names);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));

    return this.get<FredSearchResponse>(`/series/search`, query, ctx);
  }

  /** Fetch series metadata. Optional enrichment gets one short attempt. */
  getSeriesById(series_id: string, ctx: Context, policy?: 'optional'): Promise<FredSeriesResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      series_id,
    });
    return this.get<FredSeriesResponse>(`/series`, query, ctx, policy);
  }

  /** Fetch the release for a series in a single bounded attempt. */
  getSeriesRelease(series_id: string, ctx: Context): Promise<FredReleaseResponse> {
    const query = new URLSearchParams({ api_key: this.apiKey, file_type: 'json', series_id });
    return this.get<FredReleaseResponse>('/series/release', query, ctx, 'optional');
  }

  /** Fetch the exact tag names for a series in a single bounded attempt. */
  async getSeriesTags(series_id: string, ctx: Context): Promise<string[]> {
    const query = new URLSearchParams({ api_key: this.apiKey, file_type: 'json', series_id });
    const result = SeriesTagsEnvelope.safeParse(
      await this.get<unknown>('/series/tags', query, ctx, 'optional'),
    );
    if (!result.success) throw serializationError('FRED API returned invalid series tags.');
    return result.data.tags.map(({ name }) => name);
  }

  /** Fetch observations for a single series. */
  getObservations(params: GetObservationsParams, ctx: Context): Promise<FredObservationsResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      series_id: params.series_id,
    });
    if (params.observation_start) query.set('observation_start', params.observation_start);
    if (params.observation_end) query.set('observation_end', params.observation_end);
    if (params.units) query.set('units', params.units);
    if (params.frequency) query.set('frequency', params.frequency);
    if (params.aggregation_method) query.set('aggregation_method', params.aggregation_method);
    if (params.sort_order) query.set('sort_order', params.sort_order);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));

    return this.get<FredObservationsResponse>(`/series/observations`, query, ctx);
  }

  /** Fetch a category by ID. */
  getCategory(category_id: number, ctx: Context): Promise<FredCategoryResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      category_id: String(category_id),
    });
    return this.get<FredCategoryResponse>(`/category`, query, ctx);
  }

  /** Fetch child categories of a given category. */
  getCategoryChildren(category_id: number, ctx: Context): Promise<FredCategoryResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      category_id: String(category_id),
    });
    return this.get<FredCategoryResponse>(`/category/children`, query, ctx);
  }

  /** Fetch a popularity-ordered page of series attached directly to a category. */
  getCategorySeries(
    params: GetCategorySeriesParams,
    ctx: Context,
  ): Promise<FredCategorySeriesResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      category_id: String(params.category_id),
      limit: String(params.limit ?? 10),
      order_by: 'popularity',
      sort_order: 'desc',
    });
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    return this.get<FredCategorySeriesResponse>(`/category/series`, query, ctx);
  }

  /** Fetch a single release by ID. */
  getRelease(release_id: number, ctx: Context): Promise<FredReleaseResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      release_id: String(release_id),
    });
    return this.get<FredReleaseResponse>(`/release`, query, ctx);
  }

  /** Fetch all releases (used for client-side name search). */
  getAllReleases(ctx: Context): Promise<FredReleasesResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      limit: '1000',
    });
    return this.get<FredReleasesResponse>(`/releases`, query, ctx);
  }

  /** Fetch series belonging to a release. */
  getReleaseSeries(
    params: GetReleaseSeriesParams,
    ctx: Context,
  ): Promise<FredReleaseSeriesResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      release_id: String(params.release_id),
      order_by: 'popularity',
      sort_order: 'desc',
    });
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    return this.get<FredReleaseSeriesResponse>(`/release/series`, query, ctx);
  }

  /** Fetch scheduled release dates for a release. */
  getReleaseDates(params: GetReleaseDatesParams, ctx: Context): Promise<FredReleaseDatesResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      release_id: String(params.release_id),
      include_release_dates_with_no_data: 'true',
      realtime_start: new Date().toISOString().slice(0, 10),
      sort_order: 'asc',
      limit: '5',
    });
    return this.get<FredReleaseDatesResponse>(`/release/dates`, query, ctx, 'optional');
  }

  /** Fetch a page of scheduled dates across all releases within an inclusive window. */
  async listReleaseDates(params: ListReleaseDatesParams, ctx: Context) {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      realtime_start: params.start_date,
      realtime_end: params.end_date,
      include_release_dates_with_no_data: 'true',
      order_by: 'release_date',
      sort_order: 'asc',
      limit: String(params.limit),
      offset: String(params.offset),
    });
    const result = ReleaseCalendarEnvelope.safeParse(
      await this.get<unknown>('/releases/dates', query, ctx),
    );
    if (!result.success) throw serializationError('FRED API returned an invalid release calendar.');
    return result.data;
  }

  // ─── Core fetch ────────────────────────────────────────────────────────────

  private async get<T>(
    path: string,
    query: URLSearchParams,
    ctx: Context,
    policy?: 'optional',
  ): Promise<T> {
    const url = `${this.baseUrl}${path}?${query.toString()}`;
    const text =
      policy === 'optional'
        ? await this.fetchText(url, ctx.signal, FRED_OPTIONAL_TIMEOUT_MS)
        : await withRetry(({ signal }) => this.fetchText(url, signal, FRED_TIMEOUT_MS), {
            operation: `FredApiService.get${path}`,
            context: ctx,
            baseDelayMs: 1500,
            deadlineMs: FRED_RETRY_DEADLINE_MS,
            signal: ctx.signal,
          });
    ctx.signal.throwIfAborted();
    return this.parseJson<T>(text);
  }

  private async fetchText(url: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
    signal.throwIfAborted();
    const clock = new AbortController();
    const timer = setTimeout(() => clock.abort(), timeoutMs);
    try {
      let response: Response;
      let text: string | undefined;
      try {
        // The FRED key is on the URL, and upstream errors may echo it.
        response = await fetch(url, { signal: AbortSignal.any([signal, clock.signal]) });
        if (response.ok) return await response.text();
        if (response.status === 400) text = await response.text();
        else await response.body?.cancel();
      } catch {
        signal.throwIfAborted();
        if (clock.signal.aborted) throw timeout('FRED request timed out.', { timeoutMs });
        // A native fetch error or cause can contain the full request URL.
        throw serviceUnavailable('FRED request failed before the response was fully read.');
      }
      signal.throwIfAborted();
      throw fredHttpError(response, text, this.apiKey);
    } finally {
      clearTimeout(timer);
    }
  }

  private parseJson<T>(text: string): T {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serializationError(
        'FRED API returned HTML instead of JSON — likely rate-limited or server error.',
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      if (error instanceof SyntaxError) throw serializationError('FRED API returned invalid JSON.');
      throw error;
    }
  }
}

// ─── Init/accessor pattern ──────────────────────────────────────────────────

let _service: FredApiService | undefined;

export function initFredApiService(): void {
  _service = new FredApiService();
}

export function getFredApiService(): FredApiService {
  if (!_service) {
    throw new Error('FredApiService not initialized — call initFredApiService() in setup()');
  }
  return _service;
}

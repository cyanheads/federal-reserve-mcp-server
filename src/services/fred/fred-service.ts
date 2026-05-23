/**
 * @fileoverview FRED API service — wraps `api.stlouisfed.org/fred` with API key
 * injection, JSON parsing, retry with exponential backoff, and 429 rate-limit
 * detection. Single base-URL config point for staging vs. production. All public
 * methods accept `Context` for correlated logging and `AbortSignal` for
 * cancellation via `ctx.signal`.
 * @module services/fred/fred-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
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
  units?: string;
}

export interface GetReleaseDatesParams {
  release_id: number;
}

export interface GetReleaseSeriesParams {
  limit?: number;
  offset?: number;
  release_id: number;
}

export interface GetCategorySeriesParams {
  category_id: number;
  limit?: number;
}

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

  /** Fetch metadata for a single series by ID. */
  getSeriesById(series_id: string, ctx: Context): Promise<FredSeriesResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      series_id,
    });
    return this.get<FredSeriesResponse>(`/series`, query, ctx);
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

  /** Fetch a sample of series within a category (for leaf nodes). */
  getCategorySeries(
    params: GetCategorySeriesParams,
    ctx: Context,
  ): Promise<FredCategorySeriesResponse> {
    const query = new URLSearchParams({
      api_key: this.apiKey,
      file_type: 'json',
      category_id: String(params.category_id),
      limit: String(params.limit ?? 10),
    });
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
      include_release_dates_with_no_data: 'false',
      limit: '5',
    });
    return this.get<FredReleaseDatesResponse>(`/release/dates`, query, ctx);
  }

  // ─── Core fetch ────────────────────────────────────────────────────────────

  private get<T>(path: string, query: URLSearchParams, ctx: Context): Promise<T> {
    const url = `${this.baseUrl}${path}?${query.toString()}`;
    return withRetry(
      async () => {
        const response = await fetch(url, { signal: ctx.signal });
        if (!response.ok) {
          throw await httpErrorFromResponse(response, {
            service: 'FRED',
            data: { path },
          });
        }
        const text = await response.text();
        return this.parseJson<T>(text);
      },
      {
        operation: `FredApiService.get${path}`,
        baseDelayMs: 1500,
        signal: ctx.signal,
      },
    );
  }

  private parseJson<T>(text: string): T {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw new Error(
        'FRED API returned HTML instead of JSON — likely rate-limited or server error.',
      );
    }
    return JSON.parse(text) as T;
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

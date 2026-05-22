/**
 * @fileoverview FRED API domain types — raw upstream response shapes and
 * normalized domain types used by FredApiService. Raw types default fields to
 * optional because real FRED payloads are sparse; normalization preserves
 * absence rather than fabricating defaults.
 * @module services/fred/types
 */

// ─── Raw upstream shapes ────────────────────────────────────────────────────

export interface RawFredSeries {
  frequency?: string;
  frequency_short?: string;
  id: string;
  last_updated?: string;
  notes?: string;
  observation_end?: string;
  observation_start?: string;
  popularity?: number;
  seasonal_adjustment?: string;
  seasonal_adjustment_short?: string;
  title?: string;
  units?: string;
  units_short?: string;
}

export interface RawFredObservation {
  date: string;
  value: string;
}

export interface RawFredCategory {
  id: number;
  name: string;
  notes?: string;
  parent_id?: number;
}

export interface RawFredRelease {
  id: number;
  link?: string;
  name: string;
  notes?: string;
  press_release?: boolean;
}

export interface RawFredReleaseDate {
  date: string;
  release_id: number;
  release_name?: string;
}

// ─── API response envelopes ──────────────────────────────────────────────────

export interface FredSearchResponse {
  count: number;
  limit: number;
  offset: number;
  seriess: RawFredSeries[];
}

export interface FredSeriesResponse {
  seriess: RawFredSeries[];
}

export interface FredObservationsResponse {
  count: number;
  file_type: string;
  limit: number;
  observation_end: string;
  observation_start: string;
  observations: RawFredObservation[];
  offset: number;
  order_by: string;
  output_type: number;
  sort_order: string;
  units: string;
}

export interface FredCategoryResponse {
  categories: RawFredCategory[];
}

export interface FredCategorySeriesResponse {
  count: number;
  limit: number;
  offset: number;
  seriess: RawFredSeries[];
}

export interface FredReleasesResponse {
  releases: RawFredRelease[];
}

export interface FredReleaseResponse {
  releases: RawFredRelease[];
}

export interface FredReleaseSeriesResponse {
  count: number;
  limit: number;
  offset: number;
  seriess: RawFredSeries[];
}

export interface FredReleaseDatesResponse {
  release_dates: FredReleaseDate[];
}

export interface FredReleaseDate {
  date: string;
  release_id: number;
  release_name?: string;
}

// ─── Normalized domain types ─────────────────────────────────────────────────

export interface FredSeriesMeta {
  frequency: string;
  id: string;
  last_updated: string;
  notes?: string;
  observation_end?: string;
  observation_start?: string;
  popularity?: number;
  seasonal_adjustment: string;
  title: string;
  units: string;
}

export interface FredObservation {
  date: string;
  value: string;
}

export interface FredSeriesObservations {
  observation_end: string;
  observation_start: string;
  observations: FredObservation[];
  series_id: string;
  units: string;
}

export interface FredCategory {
  id: number;
  name: string;
  notes?: string;
  parent_id?: number;
}

export interface FredRelease {
  id: number;
  link?: string;
  name: string;
  notes?: string;
  press_release?: boolean;
}

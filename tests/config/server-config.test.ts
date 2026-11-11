/**
 * @fileoverview FRED deployment settings parse before tool registration.
 * @module tests/config/server-config.test
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerConfig, resetServerConfig } from '@/config/server-config.js';

describe('FRED_CLAMP_LIMITS', () => {
  beforeEach(() => {
    vi.stubEnv('FRED_API_KEY', 'test-key');
    vi.stubEnv('FRED_CLAMP_LIMITS', undefined);
    resetServerConfig();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerConfig();
  });

  it('enables batch deferral by default', () => {
    expect(getServerConfig()).toMatchObject({ clampLimits: true });
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('parses %s explicitly', (value, expected) => {
    vi.stubEnv('FRED_CLAMP_LIMITS', value);
    expect(getServerConfig()).toMatchObject({ clampLimits: expected });
  });

  it('rejects an unrecognized boolean instead of enabling it', () => {
    vi.stubEnv('FRED_CLAMP_LIMITS', 'sometimes');
    expect(() => getServerConfig()).toThrow();
  });
});

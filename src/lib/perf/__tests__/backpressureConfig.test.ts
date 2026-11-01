import { describe, it, expect, beforeEach } from 'vitest';
import {
  sanitizeBackpressureConfig,
  loadBackpressureConfig,
  DEFAULT_BACKPRESSURE_CONFIG,
} from '../backpressureConfig';

describe('backpressureConfig', () => {
  beforeEach(() => localStorage.clear());

  it('sanitize returns defaults for null/undefined', () => {
    expect(sanitizeBackpressureConfig(null)).toEqual(DEFAULT_BACKPRESSURE_CONFIG);
    expect(sanitizeBackpressureConfig(undefined)).toEqual(DEFAULT_BACKPRESSURE_CONFIG);
  });

  it('sanitize clamps out-of-range values', () => {
    const c = sanitizeBackpressureConfig({ lowFpsThreshold: 1, highFpsThreshold: 100, sustainMs: 10, maxStride: 2, forceStride: 1 });
    expect(c.lowFpsThreshold).toBe(5);
    expect(c.highFpsThreshold).toBe(60);
    expect(c.sustainMs).toBe(250);
    expect(c.maxStride).toBe(3);
    expect(c.forceStride).toBe(3);
  });

  it('sanitize enforces highFps > lowFps', () => {
    const c = sanitizeBackpressureConfig({ lowFpsThreshold: 30, highFpsThreshold: 25 });
    expect(c.highFpsThreshold).toBe(31);
  });

  it('sanitize ignores non-finite', () => {
    const c = sanitizeBackpressureConfig({ lowFpsThreshold: NaN as any, sustainMs: 'x' as any });
    expect(c.lowFpsThreshold).toBe(DEFAULT_BACKPRESSURE_CONFIG.lowFpsThreshold);
    expect(c.sustainMs).toBe(DEFAULT_BACKPRESSURE_CONFIG.sustainMs);
  });

  it('sanitize enabled boolean', () => {
    expect(sanitizeBackpressureConfig({ enabled: false }).enabled).toBe(false);
    expect(sanitizeBackpressureConfig({ enabled: 'true' as any }).enabled).toBe(true);
  });

  it('load returns default when empty', () => {
    expect(loadBackpressureConfig()).toEqual(DEFAULT_BACKPRESSURE_CONFIG);
  });

  it('load parses stored config', () => {
    localStorage.setItem('ppg_backpressure_config_v1', JSON.stringify({ enabled: false, lowFpsThreshold: 20 }));
    const c = loadBackpressureConfig();
    expect(c.enabled).toBe(false);
    expect(c.lowFpsThreshold).toBe(20);
  });

  it('load falls back on corrupt json', () => {
    localStorage.setItem('ppg_backpressure_config_v1', '{bad');
    expect(loadBackpressureConfig()).toEqual(DEFAULT_BACKPRESSURE_CONFIG);
  });
});

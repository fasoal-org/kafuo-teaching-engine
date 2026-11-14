import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND } from '@/lib/brand/brand-config';

describe('DEFAULT_BRAND (single-brand build)', () => {
  it('names the product Teaching Engine everywhere', () => {
    expect(DEFAULT_BRAND.productName).toBe('Teaching Engine');
    expect(DEFAULT_BRAND.shortName).toBe('Teaching Engine');
    // Owner, 14 Nov 2026: Kafuo navy.
    expect(DEFAULT_BRAND.themeColor).toBe('#001336');
  });

  it('never shows the upstream OpenMAIC wordmark image', () => {
    // `logo-horizontal.png` carries the OpenMAIC wordmark; surfaces render the
    // mark beside the name.
    expect(DEFAULT_BRAND.logoHasWordmark).toBe(false);
    expect(DEFAULT_BRAND.logoSrc).not.toBe('/logo-horizontal.png');
  });

  it('wears the Kafuo mark (owner, 14 Nov 2026)', () => {
    expect(DEFAULT_BRAND.markSrc).toBe('/kafuo-mark.png');
    expect(DEFAULT_BRAND.logoSrc).toBe('/kafuo-mark.png');
  });

  it('keeps no OpenMAIC product name in any display field', () => {
    expect(`${DEFAULT_BRAND.productName} ${DEFAULT_BRAND.shortName}`).not.toMatch(/openmaic/i);
  });
});

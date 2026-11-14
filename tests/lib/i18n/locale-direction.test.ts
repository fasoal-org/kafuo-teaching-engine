import { describe, expect, it } from 'vitest';
import { localeDirection } from '@/lib/i18n';

describe('localeDirection (owner, 14 Nov 2026: the teacher UI follows Arabic RTL)', () => {
  it('lays Arabic out right to left', () => {
    expect(localeDirection('ar-SA')).toBe('rtl');
    expect(localeDirection('ar')).toBe('rtl');
    expect(localeDirection('AR-sa')).toBe('rtl');
  });

  it('keeps every other shipped locale left to right', () => {
    for (const code of ['en-US', 'zh-CN', 'ja-JP', 'ru-RU', 'fr-FR', 'de-DE', 'vi-VN']) {
      expect(localeDirection(code)).toBe('ltr');
    }
  });

  it('falls back to left to right for an empty or missing locale', () => {
    expect(localeDirection('')).toBe('ltr');
    expect(localeDirection(undefined)).toBe('ltr');
    expect(localeDirection(null)).toBe('ltr');
  });
});

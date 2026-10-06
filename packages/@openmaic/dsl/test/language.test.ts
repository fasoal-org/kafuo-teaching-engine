import { describe, expect, it } from 'vitest';

import { isTextDirection, resolveTextDirection, validateStage } from '../src/index.js';

describe('resolveTextDirection', () => {
  it.each([
    ['ar', 'rtl'],
    ['AR', 'rtl'],
    ['ar-SA', 'rtl'],
    ['ar_EG', 'rtl'],
    ['he', 'rtl'],
    ['fa-IR', 'rtl'],
    ['ur', 'rtl'],
    ['ckb', 'rtl'],
    ['en', 'ltr'],
    ['en-US', 'ltr'],
    ['fr', 'ltr'],
    ['zh-Hans-CN', 'ltr'],
    ['tr', 'ltr'],
  ] as const)('%s → %s', (tag, direction) => {
    expect(resolveTextDirection(tag)).toBe(direction);
  });

  it('lets an explicit script subtag decide', () => {
    expect(resolveTextDirection('ar-Latn')).toBe('ltr');
    expect(resolveTextDirection('ku-Arab')).toBe('rtl');
    expect(resolveTextDirection('az-Arab-IR')).toBe('rtl');
    expect(resolveTextDirection('uz-Cyrl')).toBe('ltr');
  });

  it('returns undefined — never a guess — for a value that is not a language tag', () => {
    for (const value of ['', '  ', 'Arabic', 'العربية', 'x', '12', undefined, null, 7, {}]) {
      expect(resolveTextDirection(value)).toBeUndefined();
    }
  });

  it('is a pure function of the tag', () => {
    expect(resolveTextDirection('ar')).toBe(resolveTextDirection('ar'));
  });
});

describe('Stage language metadata validation', () => {
  const stage = { id: 's', name: 'S', createdAt: 1, updatedAt: 1 };

  it('accepts a legacy stage with neither field', () => {
    expect(validateStage(stage)).toEqual({ valid: true });
  });

  it('accepts language + a known direction', () => {
    expect(validateStage({ ...stage, language: 'ar', textDirection: 'rtl' })).toEqual({
      valid: true,
    });
    expect(validateStage({ ...stage, language: 'en', textDirection: 'ltr' })).toEqual({
      valid: true,
    });
  });

  it('rejects an unknown direction and an empty language at the write boundary', () => {
    const direction = validateStage({ ...stage, textDirection: 'auto' });
    expect(direction.valid).toBe(false);
    const language = validateStage({ ...stage, language: ' ' });
    expect(language.valid).toBe(false);
    expect(isTextDirection('rtl')).toBe(true);
    expect(isTextDirection('auto')).toBe(false);
  });
});

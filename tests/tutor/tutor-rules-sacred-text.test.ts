/**
 * Q-6 / Q-9 / Q-15 (quran-text-handling-rules-plan): the Kafuo tutor quotes a
 * verse or hadith only exactly from the lesson and never explains it, in both
 * halves of the byte-stable rules block (r7).
 */
import { describe, expect, it } from 'vitest';

import { TUTOR_RULES_TEXT, TUTOR_RULES_VERSION } from '@/lib/server/tutor/tutor-rules';

const [ENGLISH_RULES, ARABIC_RULES] = TUTOR_RULES_TEXT.split('\n---\n') as [string, string];

describe('tutor rules — Quran and hadith (r7)', () => {
  it('ships the policy under r7', () => {
    expect(TUTOR_RULES_VERSION).toBe('tutor-rules@r7');
  });

  it('states the policy in English', () => {
    expect(ENGLISH_RULES).toContain('## Quran and hadith (Q-6)');
    expect(ENGLISH_RULES).toContain('copy it EXACTLY, letter for letter: a verse inside ﴿ ﴾');
    expect(ENGLISH_RULES).toContain('always with its reference');
    expect(ENGLISH_RULES).toContain('Never quote one from memory');
    expect(ENGLISH_RULES).toContain(
      'Never paraphrase, translate, summarise, interpret or explain a verse or hadith',
    );
    expect(ENGLISH_RULES).toContain('the occasion of its revelation, or a ruling from it');
    expect(ENGLISH_RULES).toContain('Never invent, complete, change or shorten a verse or hadith');
  });

  it('states the same policy in Arabic', () => {
    expect(ARABIC_RULES).toContain('## القرآن الكريم والحديث الشريف');
    expect(ARABIC_RULES).toContain('وانقله حرفيًا كما ورد: الآية بين ﴿ ﴾ ومعها مرجعها دائمًا');
    expect(ARABIC_RULES).toContain('ولا تفسره ولا تشرحه، ولا تذكر معناه');
    expect(ARABIC_RULES).toContain('لا تخترع آية أو حديثًا');
  });

  it('stays byte-stable: no per-student or per-lesson data in the block', () => {
    expect(TUTOR_RULES_TEXT).not.toMatch(/\{\{|\$\{/);
  });
});

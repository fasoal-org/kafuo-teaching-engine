import { describe, expect, it } from 'vitest';

import {
  contentSurfaceWords,
  detectScript,
  extractKeywords,
  hasQuotedPhrase,
  keywordOverlap,
  longestContentRun,
  normalizeArabic,
  normalizeText,
  tokenize,
} from '@/lib/server/tutor/arabic-text';

/** Bilingual normalisation used by the assessment, the guard and the titles (plan §8.2). */
describe('normalizeArabic', () => {
  it('strips tashkeel and tatweel', () => {
    expect(normalizeArabic('الدَّرْسُ')).toBe('الدرس');
    expect(normalizeArabic('كتـــاب')).toBe('كتاب');
  });

  it('unifies alef, taa marbuta and yaa forms', () => {
    expect(normalizeArabic('أإآا')).toBe('اااا');
    expect(normalizeArabic('مدرسة')).toBe('مدرسه');
    expect(normalizeArabic('على')).toBe('علي');
    expect(normalizeArabic('مسؤول')).toBe('مسوول');
  });

  it('makes vocalised and unvocalised spellings compare equal', () => {
    expect(normalizeText('قَانُونُ حِفْظِ الكُتْلَةِ')).toBe(normalizeText('قانون حفظ الكتله'));
  });
});

describe('tokenize / extractKeywords', () => {
  it('lower-cases Latin and splits on punctuation', () => {
    expect(tokenize("What's Newton's Second Law?")).toEqual(['what', 's', 'newton', 's', 'second', 'law']);
  });

  it('drops bilingual stopwords and strips Arabic clitics', () => {
    expect(extractKeywords('ما هو قانون حفظ الكتلة في الدرس؟')).toEqual(['قانون', 'حفظ', 'كتله', 'درس']);
    expect(extractKeywords('what is the law of conservation of mass in the lesson')).toEqual([
      'law',
      'conservation',
      'mass',
      'lesson',
    ]);
  });

  it('keeps digits, dedups and preserves order', () => {
    expect(extractKeywords('الفصل 3 الفصل 3 التفاعلات')).toEqual(['فصل', '3', 'تفاعلات']);
  });

  it('returns nothing for a purely social message', () => {
    expect(extractKeywords('شكرا جدا')).toEqual([]);
    expect(extractKeywords('ok thanks')).toEqual([]);
  });
});

describe('contentSurfaceWords', () => {
  it('returns the original spelling of the content words', () => {
    expect(contentSurfaceWords('ما هو التبرير الاستقرائي في الرياضيات؟', 3)).toEqual(['التبرير', 'الاستقرائي', 'الرياضيات']);
    expect(contentSurfaceWords('What is Newton\'s Second Law?')).toEqual(['Newton', 'Second', 'Law']);
  });
});

describe('keywordOverlap', () => {
  it('is the share of query keywords found in the reference', () => {
    expect(keywordOverlap(['a', 'b', 'c', 'd'], ['b', 'd', 'x'])).toBe(0.5);
    expect(keywordOverlap([], ['x'])).toBe(0);
    expect(keywordOverlap(['a'], [])).toBe(0);
  });
});

describe('detectScript', () => {
  it('detects Arabic, English, mixed and unknown', () => {
    expect(detectScript('ما هو التسارع؟')).toBe('ar');
    expect(detectScript('What is acceleration?')).toBe('en');
    expect(detectScript('اشرح لي what is acceleration بالعربي')).toBe('mixed');
    expect(detectScript('12 + 3 = ?')).toBe('unknown');
  });

  it('ignores a stray Latin token inside an Arabic sentence', () => {
    expect(detectScript('ما معنى F = ma في قانون نيوتن الثاني؟')).toBe('ar');
  });
});

describe('lesson-discovery cues', () => {
  it('finds a quoted phrase of at least two words', () => {
    expect(hasQuotedPhrase('ما معنى "حفظ الكتلة" هنا؟')).toBe(true);
    expect(hasQuotedPhrase('what does «kinetic energy» mean')).toBe(true);
    expect(hasQuotedPhrase('what is "mass"')).toBe(false);
  });

  it('counts the longest run of consecutive content keywords', () => {
    expect(longestContentRun('قانون حفظ الكتلة في التفاعلات')).toBe(3);
    expect(longestContentRun('what is the law')).toBe(1);
  });
});

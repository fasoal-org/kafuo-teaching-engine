/**
 * S-0 (Quran/hadith review fix plan): ONE detection rule on both sides. The
 * fixture is a byte-for-byte copy of the backend's
 * `zakrly-backend/tests/fixtures/sacred_text/contract_cases.json`, which pytest
 * runs through the backend detector; every case must give the same quotes here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectSacredText, sha256Hex } from '@/lib/server/teaching-package/sacred-text';

interface ContractCase {
  id: string;
  text: string;
  expected: Array<{ kind: 'quran' | 'hadith'; text: string }>;
}

const cases = JSON.parse(
  readFileSync(path.join(process.cwd(), 'tests/fixtures/sacred-text/contract_cases.json'), 'utf8'),
) as ContractCase[];

describe('shared sacred-text detection contract', () => {
  it('carries the shared cases', () => {
    expect(cases.length).toBeGreaterThan(10);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
  });

  it.each(cases.map((entry) => [entry.id, entry] as const))('%s', (_id, entry) => {
    expect(detectSacredText(entry.text)).toEqual(entry.expected);
  });

  // TE-side cases the backend adds to the shared fixture in its next batch.
  it('detects the sixth attribution form «عن … ﷺ أنه قال» (honorific required)', () => {
    expect(
      detectSacredText(
        'عن الرسول صلى الله عليه وسلم أنه قال: "فخياركم في الجاهلية خياركم في الإسلام"',
      ),
    ).toEqual([{ kind: 'hadith', text: 'فخياركم في الجاهلية خياركم في الإسلام' }]);
    expect(detectSacredText('عن النبي ﷺ أنه يقول، «الدين النصيحة»')).toEqual([
      { kind: 'hadith', text: 'الدين النصيحة' },
    ]);
    expect(detectSacredText('عن رسول الله ﷺ أنه قال: «لا تغضب»')).toEqual([
      { kind: 'hadith', text: 'لا تغضب' },
    ]);
    // Without the honorific it is not an attribution.
    expect(detectSacredText('عن الرسول أنه قال: «الدين النصيحة»')).toEqual([]);
  });

  it('trims and splits whitespace like the backend (Python strip / \\s)', () => {
    // The BOM is not whitespace in Python; U+0085 and U+001F are.
    expect(detectSacredText('قال النبي ﷺ: «﻿الدين النصيحة﻿»')).toEqual([
      { kind: 'hadith', text: '﻿الدين النصيحة﻿' },
    ]);
    expect(detectSacredText('قال النبي ﷺ: «\u0085الدين النصيحة\u001F»')).toEqual([
      { kind: 'hadith', text: 'الدين النصيحة' },
    ]);
    expect(detectSacredText('قال النبي ﷺ: «   »')).toEqual([]);
    // A blank line may hold non-newline whitespace (here a no-break space).
    expect(detectSacredText('قال النبي ﷺ: «إنما الأعمال\n \nبالنيات»')).toEqual([]);
    // Only «:» or «،» separate the attribution from the quote.
    expect(detectSacredText('قال النبي ﷺ؛ «الدين النصيحة»')).toEqual([]);
  });

  it('pins hash the canonical (trimmed core) text', () => {
    const [hadith] = detectSacredText('قال النبي ﷺ: «  الدين النصيحة  »');
    expect(hadith).toEqual({ kind: 'hadith', text: 'الدين النصيحة' });
    expect(sha256Hex(hadith!.text)).toBe(sha256Hex('الدين النصيحة'));
  });
});

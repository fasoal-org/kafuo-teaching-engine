/**
 * R1 check shared by the guard test and phase tooling: the forbidden semantic
 * words and the per-reading violation finder (upgrade plan P0 item 6).
 */
import type { ScientificSubjectCode } from '@/lib/speech/scientific/context';
import { render } from './helpers';

/** Entity-level and explanatory words SATTS must never add, in any subject (R1, O-2, O-8). */
export const FORBIDDEN_MEANINGS: readonly string[] = [
  // Compound and ion names (O-2).
  'ماء',
  'الماء',
  'أيون',
  'حمض',
  'كلوريد',
  'أكسيد',
  'هيدروكسيد',
  'كربونات',
  'كبريتات',
  'نترات',
  'الأمونيا',
  'الأمونيوم',
  'الميثان',
  'الجلوكوز',
  'الصوديوم',
  'الكالسيوم',
  'الكربون',
  'الهيدروجين',
  'الكبريتيك',
  'الهيدروكلوريك',
  // Physical-quantity names (O-2, plan §10.2 dropped).
  'القوة',
  'السرعة',
  'التسارع',
  'الكتلة',
  'الطاقة',
  'الزمن',
  'المسافة',
  'الإزاحة',
  'الضغط',
  'الكثافة',
  // Interpretations of notation (R1, O-8, O-5).
  'ضرب اتجاهي',
  'ضرب قياسي',
  'الضرب الاتجاهي',
  'الضرب القياسي',
  'احتمال',
  'الاحتمال',
  'التوقع',
  'مشتقة',
  'المشتقة',
  // P9 notation must stay notation.
  'تركيز',
  'نظير',
  'الكربون',
  'اليورانيوم',
  'المتوسط',
  'القطعة',
  'متوسط',
];

/**
 * Conventional readings of Chemistry notation (DEC-052, supersedes O-9 and
 * O-10): allowed in a CHEMISTRY lesson, where the parser gave the sign its
 * reaction or bond role, and forbidden in every other subject.
 */
export const CHEMISTRY_CONVENTIONAL: readonly string[] = [
  'ينتج',
  'اتزان',
  'يتصاعد',
  'يترسب',
  'بالتسخين',
  'تسخين',
  'رابطة',
  'أحادية',
  'ثنائية',
  'ثلاثية',
];

export function words(text: string): string {
  return ` ${text.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean).join(' ')} `;
}

/** Forbidden words an expression reading adds that the authored text does not contain. */
export function r1Violations(text: string, subject: ScientificSubjectCode, mode: 'natural' | 'accessible'): string[] {
  const result = render(text, subject, mode);
  const original = words(text);
  const found = new Set<string>();
  for (const span of result.spans.filter((s) => s.kind === 'expression')) {
    const reading = words(result.preparedText.slice(span.prepared.start, span.prepared.end));
    const forbidden = subject === 'CHEMISTRY' ? FORBIDDEN_MEANINGS : [...FORBIDDEN_MEANINGS, ...CHEMISTRY_CONVENTIONAL];
    for (const word of forbidden) {
      if (reading.includes(` ${word} `) && !original.includes(` ${word} `)) found.add(word);
    }
  }
  return [...found].sort();
}

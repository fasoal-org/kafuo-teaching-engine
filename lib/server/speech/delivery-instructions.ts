/**
 * Versioned Saudi delivery instructions (plan §12.1, FR-020). English, under
 * 600 characters, and semantic-free: no subject vocabulary, no expression
 * meaning, no Arabic, no digits, no LaTeX — the prepared text alone carries
 * the science. Text identical to the Wave 0 screening draft.
 */
import { createHash } from 'node:crypto';

export const DELIVERY_PROFILE_ID = 'ar-SA-saudi-edu-v1';

export const DELIVERY_INSTRUCTIONS_AR_SA_V1 =
  'Read the Arabic text aloud exactly as written, with a natural Saudi Arabic accent. ' +
  'Keep the educational Modern Standard wording; never rewrite it into colloquial dialect. ' +
  'Do not add, omit, translate, paraphrase or explain anything. ' +
  'Pronounce numbers, units and terms clearly and deliberately. ' +
  'Pause briefly at every comma, and before and after any relation between quantities. ' +
  "Speak at a calm, warm teacher's pace, and keep the same voice character across consecutive parts.";

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function deliveryDigest(instructions: string | null): string | null {
  return instructions ? sha256Hex(instructions) : null;
}

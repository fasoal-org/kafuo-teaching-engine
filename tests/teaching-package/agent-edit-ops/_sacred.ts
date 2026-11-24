/** A package pin for one verse, exactly as generation pins it (sha256 of the canonical span). */
import { findSacredSpans, sha256Hex } from '@/lib/server/teaching-package/sacred-text';

export function sacredQuotePin(verse: string) {
  const span = findSacredSpans(verse).spans[0]!;
  return {
    kind: span.kind,
    sha256: sha256Hex(span.canonical),
    sourceBlockId: '1',
    contentUnitId: 'u1',
    reference: null,
    used: true,
  };
}

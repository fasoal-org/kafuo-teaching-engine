/**
 * Production readiness (upgrade plan P8): the whole SATTS reference set
 * rendered with the production pack (`allowProposed: false`).
 *
 * - Always: every dictionary entry the reference set needs exists (proposed
 *   or approved), so an approval pass can make the set fully worded.
 * - Once the manifest is approved (the P8 human gate): no expression of the
 *   set falls back to a literal form because of the policy, and R1 holds.
 */
import { describe, expect, it } from 'vitest';

import { POLICY_MANIFEST } from '@/lib/speech/scientific/policy';
import { loadAudit, loadGolden, render } from './helpers';
import { r1Violations } from './r1';

const PRODUCTION = { allowProposed: false } as const;

function referenceSet() {
  return [
    ...loadGolden().flatMap((c) => (['natural', 'accessible'] as const).map((mode) => ({ id: c.id, text: c.original, subject: c.subject, mode }))),
    ...loadAudit()
      .filter((c) => c.policy === 'proposed')
      .map((c) => ({ id: c.id, text: c.original, subject: c.subject, mode: c.mode })),
  ];
}

describe('production readiness (P8)', () => {
  it('every entry the reference set needs exists in the pack', () => {
    const missing = new Set<string>();
    for (const c of referenceSet()) {
      // With proposed entries allowed, a missing-entry warning means the entry does not exist at all.
      for (const w of render(c.text, c.subject, c.mode).warnings) {
        if (w.code === 'SATTS_W_MISSING_DICTIONARY_ENTRY') missing.add(`${c.id}: ${w.detail}`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it.runIf(POLICY_MANIFEST.status === 'approved')(
    'with the approved manifest, the reference set is fully worded and R1 holds',
    () => {
      for (const c of referenceSet()) {
        const result = render(c.text, c.subject, c.mode, PRODUCTION);
        const policyFallbacks = result.spans.filter((s) => s.fallbackReason === 'policy');
        expect(policyFallbacks.length, `${c.id} ${c.mode}: ${result.preparedText}`).toBe(0);
        expect(r1Violations(c.text, c.subject, c.mode)).toEqual([]);
      }
    },
  );

  it('while the manifest is experimental, production is gated (O-4) and nothing is approved yet', () => {
    if (POLICY_MANIFEST.status === 'approved') return;
    expect(POLICY_MANIFEST.status).toBe('experimental');
  });
});

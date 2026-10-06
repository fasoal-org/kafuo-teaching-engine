/**
 * Relocks the SATTS policy pack (upgrade plan P8): recomputes
 * `manifest.contentHash` from the dictionaries and the grammar version, the
 * same way `tests/speech/scientific/policy-lock.test.ts` checks it, and keeps
 * `rendererGrammarVersion` in step with the code.
 *
 * Usage: npx tsx scripts/satts/relock-policy.ts [--check]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { POLICY_MANIFEST, RENDERER_GRAMMAR_VERSION, policyHashInput } from '../../lib/speech/scientific/policy';

const path = join(__dirname, '..', '..', 'lib', 'speech', 'scientific', 'policy', 'ar-v1', 'manifest.json');
const expected = `sha256:${createHash('sha256').update(policyHashInput(), 'utf8').digest('hex')}`;
const manifest = JSON.parse(readFileSync(path, 'utf8')) as typeof POLICY_MANIFEST;

if (manifest.contentHash === expected && manifest.rendererGrammarVersion === RENDERER_GRAMMAR_VERSION) {
  console.log(`policy ${manifest.policyVersion} is locked (${expected})`);
} else if (process.argv.includes('--check')) {
  console.error(`policy lock is stale: expected ${expected}`);
  process.exit(1);
} else {
  manifest.contentHash = expected;
  manifest.rendererGrammarVersion = RENDERER_GRAMMAR_VERSION;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`relocked ${manifest.policyVersion}: ${expected}`);
}

/**
 * Policy lock (plan §11, FR-039, AS-007): the manifest hash covers every
 * dictionary and the grammar version, so any wording change forces a
 * deliberate version bump. On a mismatch this test prints the expected hash;
 * it never rewrites the manifest.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  POLICY_MANIFEST,
  POLICY_TABLE_FILES,
  RENDERER_GRAMMAR_VERSION,
  loadPolicyPack,
  policyHashInput,
} from '@/lib/speech/scientific/policy';
import { render } from './helpers';

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

describe('policy pack lock', () => {
  it('manifest.contentHash matches the dictionaries and grammar version', () => {
    const expected = sha256(policyHashInput());
    if (POLICY_MANIFEST.contentHash !== expected) {
      console.error(`policy-lock: expected manifest.contentHash = ${expected}`);
    }
    expect(POLICY_MANIFEST.contentHash).toBe(expected);
    expect(POLICY_MANIFEST.rendererGrammarVersion).toBe(RENDERER_GRAMMAR_VERSION);
  });

  it('a wording change changes the hash; a notes-only change does not', () => {
    const base = policyHashInput();
    const letters = POLICY_TABLE_FILES['letters.json']!;
    const reworded = {
      ...POLICY_TABLE_FILES,
      'letters.json': {
        ...letters,
        entries: letters.entries.map((e, i) => (i === 0 ? { ...e, natural: `${e.natural}!` } : e)),
      },
    };
    const renoted = {
      ...POLICY_TABLE_FILES,
      'letters.json': {
        ...letters,
        entries: letters.entries.map((e, i) => (i === 0 ? { ...e, notes: 'changed' } : e)),
      },
    };
    expect(policyHashInput(POLICY_MANIFEST, reworded)).not.toBe(base);
    expect(policyHashInput(POLICY_MANIFEST, renoted)).toBe(base);
  });

  it('lists every table file exactly once, and every file is listed', () => {
    expect([...POLICY_MANIFEST.files].sort()).toEqual(Object.keys(POLICY_TABLE_FILES).sort());
  });

  it('every entry has a status, a source and notes; no approved entry lacks its sign-off', () => {
    for (const [file, table] of Object.entries(POLICY_TABLE_FILES)) {
      const keys = new Set<string>();
      for (const entry of table.entries) {
        expect(['proposed', 'approved'], `${file}:${entry.key}`).toContain(entry.status);
        expect(typeof entry.source, `${file}:${entry.key} source`).toBe('string');
        expect(typeof entry.notes, `${file}:${entry.key} notes`).toBe('string');
        // A token may appear once per role and domain set (P2: `2` is both a number and a repeat).
        const id = `${(entry.roles ?? table.roles ?? []).join(',')}|${(entry.domains ?? table.domains ?? []).join(',')}|${entry.key}`;
        expect(keys.has(id), `${file}: duplicate ${id}`).toBe(false);
        keys.add(id);
        if (entry.status === 'approved') {
          expect(entry.approvedBy, `${file}:${entry.key} approvedBy`).toBeTruthy();
          expect(entry.approvedOn, `${file}:${entry.key} approvedOn`).toBeTruthy();
        }
      }
    }
  });

  it('the manifest stays experimental while any entry is proposed', () => {
    const anyProposed = Object.values(POLICY_TABLE_FILES).some((t) =>
      t.entries.some((e) => e.status === 'proposed'),
    );
    if (anyProposed) expect(POLICY_MANIFEST.status).toBe('experimental');
  });

  it('every Latin letter used by Mathematics has an entry (proposed allowed)', () => {
    const pack = loadPolicyPack('ar', { allowProposed: true });
    for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(pack.has('letters', ch), ch).toBe(true);
    }
  });

  it('every Arabic variable letter has a proposed entry, and none is approved', () => {
    const pack = loadPolicyPack('ar', { allowProposed: true });
    for (const ch of 'اأإآبتثجحخدذرزسشصضطظعغفقكلمنهي') {
      expect(pack.has('arabic-letters', ch), ch).toBe(true);
    }
    expect(pack.lookup('arabic-letters', 'س', 'natural')?.text).toBe('سين');
    expect(pack.lookup('arabic-letters', 'ه', 'natural')?.text).toBe('هاء');
    // The conjunction is never a variable.
    expect(pack.has('arabic-letters', 'و')).toBe(false);
    expect(POLICY_TABLE_FILES['arabic-letters.json']!.entries.every((e) => e.status === 'proposed')).toBe(true);
  });

  it('R1/O-2: no rendering code references a semantic-name table', () => {
    const root = join(process.cwd(), 'lib/speech/scientific');
    const sources = readdirSync(root, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(10);
    for (const file of sources) {
      const text = readFileSync(join(root, file), 'utf8');
      for (const table of [/'compounds'/, /'ions'/, /'quantity-expansions'/, /\bcompounds\.json/, /\bions\.json/, /quantity-expansions\.json/]) {
        expect(table.test(text), `${file} references ${table}`).toBe(false);
      }
    }
  });

  it('O-1: the pack speaks the «اثنين» register, with no «اثنان»/«اثنا» and no English counts', () => {
    for (const [file, table] of Object.entries(POLICY_TABLE_FILES)) {
      for (const entry of table.entries) {
        for (const text of [entry.natural, entry.accessible ?? '']) {
          expect(/اثنان|اثنا |اتنين/.test(text), `${file}:${entry.key} ${text}`).toBe(false);
          expect(/^(?:ون|تو|ثري|فور|فايف|سِكس|سِفن|إيت|ناين|تِن)$/.test(text), `${file}:${entry.key}`).toBe(false);
        }
      }
    }
  });

  it('production mode ignores proposed entries (never spoken, flagged as missing)', () => {
    const production = render('نحسب x² + 1', 'MATH', 'natural', { allowProposed: false });
    expect(production.stats.proposedEntriesUsed).toBe(0);
    expect(production.warnings.map((w) => w.code)).toContain('SATTS_W_MISSING_DICTIONARY_ENTRY');
    expect(production.warnings.map((w) => w.code)).not.toContain('SATTS_W_UNPROMOTED_POLICY_ENTRY');
    const shadow = render('نحسب x² + 1', 'MATH', 'natural', { allowProposed: true });
    expect(shadow.stats.proposedEntriesUsed).toBeGreaterThan(0);
    expect(shadow.warnings.map((w) => w.code)).toContain('SATTS_W_UNPROMOTED_POLICY_ENTRY');
    expect(loadPolicyPack('ar', { allowProposed: true }).status).toBe('experimental');
  });
});

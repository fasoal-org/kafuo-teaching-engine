/**
 * Role-aware dictionary resolution (upgrade plan P2, R4): Token + Subject +
 * Role → reading, with the `(table, key)` compatibility layer, recognition
 * separated from wording, and case kept internally (O-3).
 */
import { describe, expect, it } from 'vitest';

import { parseChemistry } from '@/lib/speech/scientific/chemistry/parse';
import { verbaliseChemistry } from '@/lib/speech/scientific/chemistry/verbalise-ar';
import { FUNCTION_NAMES } from '@/lib/speech/scientific/math/tokenize';
import { PREFIX_KEYS, UNIT_KEYS } from '@/lib/speech/scientific/physics/units';
import {
  loadPolicyPack,
  POLICY_TABLE_FILES,
  policyEntries,
  type PolicyDomain,
  type PolicyRole,
} from '@/lib/speech/scientific/policy';
import { prepared, TEST_POLICY } from './helpers';

const read = (role: PolicyRole, token: string, domain: PolicyDomain | null, mode: 'natural' | 'accessible' = 'natural') =>
  TEST_POLICY.resolve({ role, token, domain }, mode)?.text ?? null;

describe('role-aware resolution (P2)', () => {
  it('the same token reads by role and subject', () => {
    expect(read('variable', 'x', 'MATH')).toBe('سين');
    expect(read('variable', 'x', 'PHYSICS')).toBe('إكس');
    expect(read('variable', 'm', 'MATH')).toBe('ميم');
    expect(read('variable', 'm', 'PHYSICS')).toBe('إم');
    expect(read('unit', 'm', 'PHYSICS')).toBe('متر');
    expect(read('prefix', 'm', 'PHYSICS')).toBe('ملي');
    expect(read('element', 'H', 'CHEMISTRY')).toBe('إتش');
    // An Arabic-letter variable reads the same in every subject.
    for (const domain of ['MATH', 'PHYSICS'] as const) expect(read('variable', 'س', domain)).toBe('سين');
  });

  it('a subject-specific entry wins; subject-independent entries serve every subject', () => {
    expect(read('label', 'electron', 'CHEMISTRY')).toBe('إلكترون');
    expect(read('label', 'electron', 'MATH')).toBeNull();
    expect(read('label', 'fraction', 'CHEMISTRY')).toBe('الكسر');
    expect(read('greek', 'alpha', 'PHYSICS')).toBe('ألفا');
  });

  it('falls back to the neutral symbol name, then to nothing (the caller speaks the raw token)', () => {
    expect(read('operator', '∞', 'MATH')).toBe('ما لا نهاية');
    expect(read('variable', 'ж', 'MATH')).toBeNull();
  });

  it('production reads nothing while every entry is proposed', () => {
    const production = loadPolicyPack('ar', { allowProposed: false });
    expect(production.resolve({ role: 'variable', token: 'x', domain: 'MATH' }, 'natural')).toBeNull();
  });

  it('the compatibility layer returns exactly what the resolver returns', () => {
    const legacy = (entry: ReturnType<typeof policyEntries>[number]): string[] => {
      if (entry.roles.includes('symbol')) return [`sym:${entry.key}`];
      if (entry.table === 'operators' && entry.domains?.includes('CHEMISTRY')) return [`chem:${entry.key}`];
      if (entry.roles.includes('number')) return [`nom:${entry.key}`, `gen:${entry.key}`];
      if (entry.roles.includes('repeat')) return [`times:${entry.key}`];
      return [entry.key];
    };
    let checked = 0;
    for (const entry of policyEntries()) {
      const domain = entry.domains?.[0] ?? null;
      for (const mode of ['natural', 'accessible'] as const) {
        const resolved = TEST_POLICY.resolve({ role: entry.roles[0]!, token: entry.key, domain }, mode)?.text;
        for (const key of legacy(entry)) {
          expect(TEST_POLICY.lookup(entry.table, key, mode)?.text, `${entry.table}:${key}`).toBe(resolved);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(600);
  });

  it('role encodings are fields, not key prefixes', () => {
    for (const [file, table] of Object.entries(POLICY_TABLE_FILES)) {
      for (const entry of table.entries) {
        expect(/^(?:nom|gen|times|count|sym|chem):/.test(entry.key), `${file}:${entry.key}`).toBe(false);
      }
    }
  });
});

describe('recognition is separated from wording (P2 item 4)', () => {
  const keys = (file: string) => POLICY_TABLE_FILES[file]!.entries.map((e) => e.key).sort();

  it('units, prefixes and functions are recognised from the dictionary keys', () => {
    expect([...UNIT_KEYS].sort()).toEqual(keys('units.json'));
    const prefixes = POLICY_TABLE_FILES['prefixes.json']!.entries.flatMap((e) => [e.key, ...(e.aliases ?? [])]);
    expect([...PREFIX_KEYS].sort()).toEqual(prefixes.sort());
    expect([...FUNCTION_NAMES].sort()).toEqual(keys('functions.json'));
  });

  it('recognition does not depend on approval: production still parses `5 km` as a unit', () => {
    const production = loadPolicyPack('ar', { allowProposed: false });
    expect(production.resolve({ role: 'unit', token: 'm', domain: 'PHYSICS' }, 'natural')).toBeNull();
    expect(UNIT_KEYS).toContain('m');
  });
});

describe('O-3: case, role and domain are kept internally, never voiced as markers', () => {
  const chem = (formula: string) =>
    verbaliseChemistry(parseChemistry(formula, { inCe: true }), {
      policy: TEST_POLICY,
      mode: 'natural',
      domain: 'CHEMISTRY',
      warn: () => {},
      noteProposed: () => {},
    }).writer;

  it('CO and Co read the same by ear, and differ in the ordered semantic tokens', () => {
    expect(chem('CO').toString()).toBe(chem('Co').toString());
    expect(chem('CO').semantic).not.toEqual(chem('Co').semantic);
    expect(chem('CO').toString()).not.toMatch(/كابتل|كبيرة|صغيرة/);
  });

  it('letter names use standard Arabic letters (P2 item 6)', () => {
    expect(prepared('الدالة $p$ هنا')).toBe('الدالة بي هنا');
    const letters = POLICY_TABLE_FILES['letters.json']!.entries.map((e) => e.natural);
    expect(letters.filter((text) => text.includes('پ'))).toEqual([]);
  });

  it('no letter or element reading sounds like an operator or connective word', () => {
    const operators = new Set(
      policyEntries()
        .filter((e) => e.roles.includes('operator') || e.roles.includes('label'))
        .map((e) => e.natural)
        .filter((text) => text.trim()),
    );
    for (const entry of policyEntries()) {
      if (!entry.roles.includes('variable') && !entry.roles.includes('element')) continue;
      expect(operators.has(entry.natural), `${entry.table}:${entry.key} «${entry.natural}»`).toBe(false);
    }
  });
});

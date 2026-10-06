import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Deployment durability guard (Kafuo R1 plan §9.4, F9): Postgres is the ONLY
 * durable store the Kafuo path may rely on. A file under `data/` does not
 * survive instance replacement and is invisible to other instances, so the
 * teaching-model executor, ledger, sweepers and the tutor runtime must never
 * reach for the local filesystem — not `process.cwd()`, not a `data/` path,
 * not a `node:fs` write. Review found the first revision of this design
 * parked failed writes in `data/outbox/**`; this test is what keeps that
 * from coming back.
 */

const GUARDED_DIRS = ['lib/server/teaching-model', 'lib/server/tutor'] as const;

const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern: /process\.cwd\(\)/,
    why: 'process.cwd() — a local path is not durable across instances',
  },
  { pattern: /['"`]data\//, why: "a 'data/' path — the openmaic-data volume is host-local" },
  {
    pattern: /from\s+['"](node:)?fs(\/promises)?['"]/,
    why: 'a node:fs import — no local file I/O on the Kafuo path',
  },
  {
    pattern: /require\(\s*['"](node:)?fs(\/promises)?['"]\s*\)/,
    why: 'a node:fs require — no local file I/O on the Kafuo path',
  },
  {
    pattern: /\b(writeFile|appendFile|mkdir|writeFileSync|appendFileSync|mkdirSync)\s*\(/,
    why: 'a filesystem write',
  },
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no local state on the Kafuo teaching path', () => {
  const files = GUARDED_DIRS.flatMap((dir) => listSourceFiles(path.resolve(process.cwd(), dir)));

  it('covers the guarded directories (the guard is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${path.relative(process.cwd(), file)} touches no local filesystem state`, () => {
      const source = readFileSync(file, 'utf8');
      const violations = FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(
        ({ why }) => why,
      );
      expect(violations, `${file} uses: ${violations.join('; ')}`).toEqual([]);
    });
  }
});

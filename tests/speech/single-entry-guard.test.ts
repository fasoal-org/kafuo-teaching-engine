/**
 * Drift guard (plan §6): only the Narration Synthesis Service may import the
 * provider entry `generateTTS`, so no narration path can bypass context,
 * rendering, segmentation, fingerprinting and usage accounting again.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const SCAN = ['lib', 'app', 'components', 'packages/@openmaic'];
const ALLOWED = new Set([
  'lib/server/speech/narration-synthesis.ts',
  // The provider module defines it.
  'lib/audio/tts-providers.ts',
]);

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out = out.concat(walk(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe('single narration entry (drift guard)', () => {
  it('only allowed modules import generateTTS', () => {
    const offenders: string[] = [];
    for (const base of SCAN) {
      for (const file of walk(join(ROOT, base))) {
        const text = readFileSync(file, 'utf8');
        if (!/\bgenerateTTS\b/.test(text)) continue;
        const imports = /import\s*\{[^}]*\bgenerateTTS\b[^}]*\}\s*from|import\(\s*['"][^'"]*tts-providers['"]\s*\)/.test(text);
        const rel = relative(ROOT, file);
        if (imports && !ALLOWED.has(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

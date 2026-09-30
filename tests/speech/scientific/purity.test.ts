/**
 * Static guards on the renderer source (plan §9.1, §15): no I/O, no clock, no
 * randomness, no environment, no model, no KaTeX/DOM, no eval — and no
 * regular expression with nested quantifiers over user text.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..', 'lib', 'speech', 'scientific');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

const FILES = sources(ROOT).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

const FORBIDDEN: Array<[string, RegExp]> = [
  ['node built-in import', /from ['"](node:|fs|path|http|https|net|child_process|os|crypto)['"/]/],
  ['app/server import', /from ['"]@\/(?!lib\/speech\/scientific)/],
  ['environment access', /process\.env/],
  ['clock', /\bDate\b|performance\.now/],
  ['randomness', /Math\.random/],
  ['eval', /\beval\s*\(|new Function\s*\(/],
  ['KaTeX / DOM', /katex|document\.|window\./],
  ['network', /\bfetch\s*\(/],
];

describe('renderer purity (lint)', () => {
  it('finds the renderer sources', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN)('no %s', (_label, pattern) => {
    const offenders = FILES.filter((file) => pattern.test(file.text)).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('no regular expression literal with a nested quantifier', () => {
    // A group containing + or * that is itself quantified: (a+)+, (a*)*, (x+y)+ …
    const nested = /\/[^/\n]*\([^()\n]*[+*][^()\n]*\)[+*{][^/\n]*\//;
    const offenders = FILES.flatMap((file) =>
      file.text
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .filter((line) => nested.test(line))
        .map((line) => `${file.path}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});

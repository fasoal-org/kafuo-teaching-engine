import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ED-10 (critical items before package regeneration, 27 Nov 2026): the slide editor's
 * right-click menus (an element's, and the blank canvas's) were Chinese for every
 * teacher. Their words now come from `edit.contextMenu.*` in every locale; the two
 * files carry no Chinese text of their own.
 */
const ROOT = resolve(__dirname, '../..');
const MENU_FILES = [
  'components/slide-renderer/Editor/Canvas/EditableElement.tsx',
  'components/slide-renderer/Editor/Canvas/index.tsx',
];
const LOCALES_DIR = join(ROOT, 'lib/i18n/locales');
const CJK = /[㐀-鿿豈-﫿]/;

function keysIn(source: string): string[] {
  return [...source.matchAll(/\bt\(\s*'([^']+)'/g)].map((match) => match[1]!);
}

function resolveKey(resource: unknown, key: string): unknown {
  let value = resource;
  for (const part of key.split('.')) value = (value as Record<string, unknown> | undefined)?.[part];
  return value;
}

describe('slide editor context menus', () => {
  const sources = MENU_FILES.map((file) => readFileSync(join(ROOT, file), 'utf8'));
  const keys = [...new Set(sources.flatMap(keysIn))];

  it('carry no Chinese text of their own', () => {
    for (const [index, source] of sources.entries()) {
      const offending = source
        .split('\n')
        .filter(
          (line) => CJK.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*'),
        );
      expect(offending, MENU_FILES[index]).toEqual([]);
    }
  });

  it('use only edit.canvasMenu keys, each a non-empty string in all 12 locales', () => {
    expect(keys.length).toBeGreaterThanOrEqual(25);
    expect(keys.every((key) => key.startsWith('edit.canvasMenu.'))).toBe(true);
    const locales = readdirSync(LOCALES_DIR).filter((name) => name.endsWith('.json'));
    expect(locales).toHaveLength(12);
    for (const locale of locales) {
      const raw = readFileSync(join(LOCALES_DIR, locale), 'utf8');
      // One block per locale: a second `"canvasMenu"` object would silently replace it.
      expect(raw.match(/"canvasMenu": \{/g), locale).toHaveLength(1);
      const resource = JSON.parse(raw) as unknown;
      for (const key of keys) {
        const value = resolveKey(resource, key);
        expect(typeof value === 'string' && value.trim().length > 0, `${locale} ${key}`).toBe(true);
      }
    }
  });

  it('read Arabic in the Arabic locale', () => {
    const ar = JSON.parse(readFileSync(join(LOCALES_DIR, 'ar-SA.json'), 'utf8')) as unknown;
    expect(resolveKey(ar, 'edit.canvasMenu.cut')).toBe('قص');
    expect(resolveKey(ar, 'edit.canvasMenu.delete')).toBe('حذف');
  });
});

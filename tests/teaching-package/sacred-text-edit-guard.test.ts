/**
 * Q-14: the package editor's document / Scene write is refused when it changes
 * a pinned Quran verse or hadith; a Stage without pins is never checked.
 */
import { describe, expect, it, vi } from 'vitest';

import { sacredTextEditRefusal } from '@/lib/server/teaching-package/sacred-text-edit-guard';
import { sha256Hex, type SacredQuotePin } from '@/lib/server/teaching-package/sacred-text';

const VERSE = '﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ مِنْهُ آيَاتٌ مُّحْكَمَاتٌ﴾';
const pins: SacredQuotePin[] = [
  {
    kind: 'quran',
    sha256: sha256Hex(VERSE),
    sourceBlockId: '41',
    contentUnitId: 'cu-1',
    reference: 'سورة آل عمران الآية: 7',
    used: true,
  },
];

function reader(outline: unknown) {
  return {
    query: vi.fn(async () => ({ rows: outline === undefined ? [] : [{ data: outline }] })),
  };
}

function scene(text: string) {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    content: { type: 'slide', canvas: { elements: [{ id: 't', type: 'text', content: text }] } },
    actions: [],
  };
}

function put(path: string, body: unknown) {
  return new Request(`http://te.test/api/persistence${path}`, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('sacredTextEditRefusal', () => {
  it('lets an edit through that keeps the pinned verse exactly', async () => {
    const path = '/documents/stage-1/scenes/scene-1';
    const request = put(path, scene(`<p>عيّن التابع: ${VERSE}</p>`));
    expect(await sacredTextEditRefusal(request, path, reader({ sacredQuotes: pins }))).toBeNull();
    // The body is still readable by the store after the check.
    expect(((await request.json()) as { id: string }).id).toBe('scene-1');
  });

  it('refuses a Scene write that changes one letter of the pinned verse', async () => {
    const path = '/documents/stage-1/scenes/scene-1';
    const changed = VERSE.replace('أَنزَلَ', 'نَزَّلَ');
    const refusal = await sacredTextEditRefusal(
      put(path, scene(changed)),
      path,
      reader({ sacredQuotes: pins }),
    );
    expect(refusal).toMatchObject({
      status: 422,
      code: 'SACRED_TEXT_PINNED',
      scenes: [{ id: 'scene-1', code: 'SACRED_TEXT_PINNED' }],
    });
  });

  it('refuses a whole-document write that drops the pins', async () => {
    const path = '/documents/stage-1';
    const body = { stage: { id: 'stage-1' }, scenes: [scene(VERSE)], outline: { outlines: [] } };
    const refusal = await sacredTextEditRefusal(
      put(path, body),
      path,
      reader({ sacredQuotes: pins }),
    );
    expect(refusal?.code).toBe('SACRED_TEXT_PINNED');
    const kept = { ...body, outline: { outlines: [], sacredQuotes: pins } };
    expect(
      await sacredTextEditRefusal(put(path, kept), path, reader({ sacredQuotes: pins })),
    ).toBeNull();
  });

  it('refuses a whole-document save of a pinned Stage without an outline (S-1)', async () => {
    const path = '/documents/stage-1';
    // The store deletes the outline record (and its pins) on such a save.
    for (const body of [
      { stage: { id: 'stage-1' }, scenes: [scene(VERSE)] },
      { stage: { id: 'stage-1' }, scenes: [scene(VERSE)], outline: null },
      { stage: { id: 'stage-1' }, scenes: [], outline: { outlines: [], sacredQuotes: null } },
    ]) {
      const refusal = await sacredTextEditRefusal(
        put(path, body),
        path,
        reader({ sacredQuotes: pins }),
      );
      expect(refusal?.code, JSON.stringify(Object.keys(body))).toBe('SACRED_TEXT_PINNED');
    }
    // An empty pin list is still pins: a save must carry it too.
    const empty = { stage: { id: 'stage-1' }, scenes: [scene('نص')] };
    expect(
      (await sacredTextEditRefusal(put(path, empty), path, reader({ sacredQuotes: [] })))?.code,
    ).toBe('SACRED_TEXT_PINNED');
    expect(
      await sacredTextEditRefusal(
        put(path, { ...empty, outline: { outlines: [], sacredQuotes: [] } }),
        path,
        reader({ sacredQuotes: [] }),
      ),
    ).toBeNull();
  });

  it('M-1: checks the edit against the quotes the STORED Scenes show', async () => {
    const stored = scene(`<p>عيّن التابع: ${VERSE}</p>`);
    const bySql = {
      query: vi.fn(async (sql: string) =>
        sql.includes('document_scenes')
          ? { rows: [{ data: JSON.stringify(stored) }] }
          : { rows: [{ data: { sacredQuotes: pins } }] },
      ),
    };
    const path = '/documents/stage-1/scenes/scene-1';
    // Brackets removed and a letter changed: no span is left, but the copy is.
    const unbracketed = scene('قال تعالى: هو الذي نزل عليك الكتاب منه آيات محكمات');
    expect(await sacredTextEditRefusal(put(path, unbracketed), path, bySql)).toMatchObject({
      status: 422,
      code: 'SACRED_TEXT_PINNED',
      scenes: [{ id: 'scene-1', code: 'SACRED_TEXT_ALTERED' }],
    });
    // The same edit under a new Scene id, inside a whole-document save.
    const documentPath = '/documents/stage-1';
    const document = {
      stage: { id: 'stage-1' },
      scenes: [stored, { ...unbracketed, id: 'scene-2' }],
      outline: { outlines: [], sacredQuotes: pins },
    };
    expect(
      (await sacredTextEditRefusal(put(documentPath, document), documentPath, bySql))?.scenes,
    ).toEqual([{ id: 'scene-2', code: 'SACRED_TEXT_ALTERED' }]);
    // Speech that reads the stored verse in plain words.
    const spoken = {
      ...scene('نص'),
      actions: [{ id: 's', type: 'speech', text: 'هو الذي أنزل عليك الكتاب منه' }],
    };
    expect((await sacredTextEditRefusal(put(path, spoken), path, bySql))?.scenes).toEqual([
      { id: 'scene-1', code: 'SACRED_TEXT_NARRATED' },
    ]);
    // A new faithful cut of the stored verse passes (M-3).
    const cut = scene('﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ …﴾');
    expect(await sacredTextEditRefusal(put(path, cut), path, bySql)).toBeNull();
    // The unchanged stored Scene passes.
    expect(await sacredTextEditRefusal(put(path, stored), path, bySql)).toBeNull();
  });

  it('M-3/M-4: an unchanged save of a stored, unpinned cut or wrapped verse passes', async () => {
    const words = VERSE.split(' ');
    for (const shown of [
      '﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ …﴾',
      `<p>${words.slice(0, 3).join(' ')}<br>${words.slice(3).join(' ')}</p>`,
    ]) {
      // Written by a regeneration (no new pin); the full verse is in no stored Scene.
      const stored = scene(shown);
      const bySql = {
        query: vi.fn(async (sql: string) =>
          sql.includes('document_scenes')
            ? { rows: [{ data: JSON.stringify(stored) }] }
            : { rows: [{ data: { sacredQuotes: pins } }] },
        ),
      };
      const path = '/documents/stage-1/scenes/scene-1';
      expect(await sacredTextEditRefusal(put(path, stored), path, bySql), shown).toBeNull();
      const documentPath = '/documents/stage-1';
      const document = {
        stage: { id: 'stage-1' },
        scenes: [stored],
        outline: { outlines: [], sacredQuotes: pins },
      };
      expect(
        await sacredTextEditRefusal(put(documentPath, document), documentPath, bySql),
        shown,
      ).toBeNull();
      // A changed letter inside it is still refused.
      const changed = scene(shown.replace('عَلَيْكَ', 'عَلَيْهِ'));
      expect((await sacredTextEditRefusal(put(path, changed), path, bySql))?.code, shown).toBe(
        'SACRED_TEXT_PINNED',
      );
    }
  });

  it('N-H1: refuses a cut that closes the gap of a stored ASCII "..." cut', async () => {
    const asciiCut = '﴿هُوَ الَّذِي ... مِنْهُ آيَاتٌ مُّحْكَمَاتٌ﴾';
    const stored = scene(asciiCut);
    const bySql = {
      query: vi.fn(async (sql: string) =>
        sql.includes('document_scenes')
          ? { rows: [{ data: JSON.stringify(stored) }] }
          : { rows: [{ data: { sacredQuotes: pins } }] },
      ),
    };
    const path = '/documents/stage-1/scenes/scene-1';
    expect(await sacredTextEditRefusal(put(path, stored), path, bySql)).toBeNull();
    const gapClosed = scene('﴿هُوَ الَّذِي مِنْهُ آيَاتٌ …﴾');
    expect(await sacredTextEditRefusal(put(path, gapClosed), path, bySql)).toMatchObject({
      code: 'SACRED_TEXT_PINNED',
      scenes: [{ id: 'scene-1', code: 'SACRED_TEXT_PINNED' }],
    });
  });

  it('never checks a Stage without pins, a read, or a stage-only write', async () => {
    const changed = scene('﴿قول مخترع﴾');
    const scenePath = '/documents/stage-1/scenes/scene-1';
    expect(await sacredTextEditRefusal(put(scenePath, changed), scenePath, reader({}))).toBeNull();
    expect(
      await sacredTextEditRefusal(put(scenePath, changed), scenePath, reader(undefined)),
    ).toBeNull();
    const get = new Request(`http://te.test/api/persistence${scenePath}`);
    expect(await sacredTextEditRefusal(get, scenePath, reader({ sacredQuotes: pins }))).toBeNull();
    const stagePath = '/documents/stage-1/stage';
    expect(
      await sacredTextEditRefusal(put(stagePath, {}), stagePath, reader({ sacredQuotes: pins })),
    ).toBeNull();
  });
});

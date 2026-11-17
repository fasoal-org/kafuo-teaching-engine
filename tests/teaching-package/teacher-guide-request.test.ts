/**
 * g5.v11 (teacher-guide answer referee plan §7, 16 Nov 2026): the optional `teacherGuide`
 * block of a Kafuo generation request. It is validated whenever sent, covered by the
 * digest, and kept on the attempt (snapshot and runner context) on g5.v11 only.
 */
import { describe, expect, it } from 'vitest';

import { toGenerationInputSnapshot } from '@/lib/server/teaching-package/generation';
import {
  buildKafuoStartRequest,
  canonicalRequestDigest,
  parseKafuoGenerationRequest,
  teacherGuideSnapshotFacts,
} from '@/lib/server/teaching-package/kafuo-request';

const GUIDE = {
  guideId: 'tg-1',
  items: [
    {
      contentUnitId: '6247',
      label: '1',
      status: 'approved',
      answer: { type: 'number', value: 11.25, unit: 'ريال' },
    },
    { contentUnitId: '6249', label: '11b', status: 'doubtful' },
    { contentUnitId: '6250', label: '12', status: 'reference' },
    {
      contentUnitId: '6234',
      label: '1A',
      status: 'settled',
      answer: { type: 'choice', value: 'ج' },
    },
  ],
};

function body(version: string, overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'kafuo-req-1',
    tenantContext: { tenantId: 'tenant-1' },
    actorRef: 'user-42',
    learningItem: {
      type: 'lesson',
      id: '901',
      title: 'Patterns',
      unit: { id: '12', title: 'Unit 1' },
      curriculum: { id: '5', name: 'Math 10' },
      curriculumVersion: { id: '8', versionLabel: '2026-A' },
      language: 'ar',
    },
    learningObjectives: [{ objectiveRef: '7001', snapshot: { statement: 'Use patterns.' } }],
    teachingModel: {
      key: 'g5',
      version,
      flow: [{ stage: 'lesson_opener', instructions: 'Open the lesson.' }],
    },
    contentResource: {
      id: 'cs-77',
      url: 'https://r2.example.test/lesson.pdf?X-Amz-Signature=abc',
      mimeType: 'application/pdf',
    },
    generation: { enableTTS: true },
    ...overrides,
  };
}

const parse = (version: string, teacherGuide: unknown) =>
  parseKafuoGenerationRequest(body(version, { teacherGuide })).request;

describe('teacherGuide parsing', () => {
  it('keeps the records key by key, optional keys only when sent', () => {
    const request = parse('g5.v11', {
      ...GUIDE,
      extra: 'dropped',
      items: [{ ...GUIDE.items[0], note: 'dropped' }, ...GUIDE.items.slice(1)],
    });
    expect(request.teacherGuide).toEqual(GUIDE);
  });

  it('keeps an approximate number answer', () => {
    const request = parse('g5.v11', {
      guideId: 'tg-1',
      items: [
        {
          contentUnitId: '1',
          label: '2',
          status: 'approved',
          answer: { type: 'number', value: 3.1, approximate: true },
        },
      ],
    });
    expect(request.teacherGuide?.items[0]?.answer).toEqual({
      type: 'number',
      value: 3.1,
      approximate: true,
    });
  });

  it('is absent when not sent', () => {
    expect(parseKafuoGenerationRequest(body('g5.v11')).request.teacherGuide).toBeUndefined();
  });

  const refused: Array<[string, unknown]> = [
    ['a non-object', []],
    ['no guideId', { items: [] }],
    ['no items', { guideId: 'tg-1' }],
    [
      'an unknown status',
      { guideId: 'g', items: [{ contentUnitId: '1', label: '1', status: 'ok' }] },
    ],
    [
      'an empty label',
      { guideId: 'g', items: [{ contentUnitId: '1', label: ' ', status: 'missing' }] },
    ],
    [
      'an approved item without an answer',
      { guideId: 'g', items: [{ contentUnitId: '1', label: '1', status: 'approved' }] },
    ],
    [
      'an answer on a doubtful item',
      {
        guideId: 'g',
        items: [
          {
            contentUnitId: '1',
            label: '1',
            status: 'doubtful',
            answer: { type: 'bool', value: true },
          },
        ],
      },
    ],
    [
      'a repeated item',
      {
        guideId: 'g',
        items: [
          { contentUnitId: '1', label: '1', status: 'missing' },
          { contentUnitId: '1', label: '1', status: 'reference' },
        ],
      },
    ],
    [
      'a non-finite number',
      {
        guideId: 'g',
        items: [
          {
            contentUnitId: '1',
            label: '1',
            status: 'approved',
            answer: { type: 'number', value: '3' },
          },
        ],
      },
    ],
    [
      'a choice that is not one letter',
      {
        guideId: 'g',
        items: [
          {
            contentUnitId: '1',
            label: '1',
            status: 'approved',
            answer: { type: 'choice', value: 'E' },
          },
        ],
      },
    ],
    [
      'an unknown answer type',
      {
        guideId: 'g',
        items: [
          {
            contentUnitId: '1',
            label: '1',
            status: 'approved',
            answer: { type: 'figure', value: 1 },
          },
        ],
      },
    ],
    [
      'approximate on a text answer',
      {
        guideId: 'g',
        items: [
          {
            contentUnitId: '1',
            label: '1',
            status: 'approved',
            answer: { type: 'text', value: 'شوال', approximate: true },
          },
        ],
      },
    ],
  ];
  it.each(refused)('refuses %s', (_name, teacherGuide) => {
    expect(() => parse('g5.v11', teacherGuide)).toThrow(/teacherGuide/);
  });

  it('never reads the block on g5.v8–v10: a malformed one never fails their request (D-20)', () => {
    for (const version of ['g5.v8', 'g5.v9', 'g5.v10']) {
      const request = parse(version, { guideId: 'g' });
      expect(request.teacherGuide).toBeUndefined();
      expect(canonicalRequestDigest(request)).toBe(
        canonicalRequestDigest(parseKafuoGenerationRequest(body(version)).request),
      );
    }
  });

  it('reads `unit: null` and `approximate: false` as absent (D-20)', () => {
    const request = parse('g5.v11', {
      guideId: 'tg-1',
      items: [
        {
          contentUnitId: '1',
          label: '2',
          status: 'approved',
          answer: { type: 'number', value: 3.1, unit: null, approximate: false },
        },
        {
          contentUnitId: '1',
          label: '3',
          status: 'approved',
          answer: { type: 'text', value: 'شوال', unit: null, approximate: false },
        },
      ],
    });
    expect(request.teacherGuide?.items.map((item) => item.answer)).toEqual([
      { type: 'number', value: 3.1 },
      { type: 'text', value: 'شوال' },
    ]);
    const plain = parse('g5.v11', {
      guideId: 'tg-1',
      items: [
        {
          contentUnitId: '1',
          label: '2',
          status: 'approved',
          answer: { type: 'number', value: 3.1 },
        },
        {
          contentUnitId: '1',
          label: '3',
          status: 'approved',
          answer: { type: 'text', value: 'شوال' },
        },
      ],
    });
    expect(canonicalRequestDigest(request)).toBe(canonicalRequestDigest(plain));
  });
});

/** A figure's image as the Backend sends it: the presigned URL is minted at send time. */
const FIGURE_URL = 'https://r2.example.test/teacher-guides/tg-1/answer-12.png?X-Amz-Signature=fig';
const FIGURE_IMAGE = {
  checksumSha256: 'a'.repeat(64),
  mimeType: 'image/png',
  sizeBytes: 48_213,
  url: FIGURE_URL,
};

describe('teacherGuide model answers (owner, 17 Nov 2026)', () => {
  const PROOF = 'المعطيات: ∠1 و∠2 متكاملتان.\nالبرهان: م∠1 + م∠2 = 180°، إذن …';
  const reference = (modelAnswer: unknown, status = 'reference') => ({
    guideId: 'tg-1',
    items: [{ contentUnitId: '6250', label: '12', status, modelAnswer }],
  });

  it('keeps a reference item’s model answer key by key, its text exactly as sent', () => {
    const request = parse(
      'g5.v11',
      reference({ kind: 'proof', text: `${PROOF}\n`, note: 'dropped', image: null }),
    );
    expect(request.teacherGuide?.items[0]).toEqual({
      contentUnitId: '6250',
      label: '12',
      status: 'reference',
      modelAnswer: { kind: 'proof', text: `${PROOF}\n` },
    });
    expect(
      parse('g5.v11', reference({ kind: 'possible', text: 'إجابة ممكنة: 2، 4، 8' })).teacherGuide
        ?.items[0]?.modelAnswer,
    ).toEqual({ kind: 'possible', text: 'إجابة ممكنة: 2، 4، 8' });
  });

  it('counts the 4000-character limit in characters (code points), as the Backend', () => {
    // 4000 astral math letters: 8000 UTF-16 units, 4000 characters.
    const astral = '𝑥'.repeat(4_000);
    expect(parse('g5.v11', reference({ kind: 'proof', text: astral })).teacherGuide).toBeDefined();
    expect(() => parse('g5.v11', reference({ kind: 'proof', text: `${astral}x` }))).toThrow(
      /modelAnswer\.text/,
    );
    expect(() => parse('g5.v11', reference({ kind: 'proof', text: 'ب'.repeat(4_001) }))).toThrow(
      /at most 4000 characters/,
    );
  });

  it('reads `modelAnswer: null` as absent, on any status (D-20)', () => {
    const withNull = parse('g5.v11', reference(null, 'missing'));
    expect(withNull.teacherGuide?.items[0]).toEqual({
      contentUnitId: '6250',
      label: '12',
      status: 'missing',
    });
  });

  const refusedModelAnswers: Array<[string, unknown]> = [
    [
      'on an approved item',
      {
        guideId: 'g',
        items: [
          {
            contentUnitId: '1',
            label: '1',
            status: 'approved',
            answer: { type: 'number', value: 2 },
            modelAnswer: { kind: 'proof', text: 'برهان' },
          },
        ],
      },
    ],
    ['on a settled item', reference({ kind: 'proof', text: 'برهان' }, 'settled')],
    ['on a doubtful item', reference({ kind: 'proof', text: 'برهان' }, 'doubtful')],
    ['on a changed item', reference({ kind: 'possible', text: 'إجابة' }, 'changed')],
    ['on a missing item', reference({ kind: 'possible', text: 'إجابة' }, 'missing')],
    ['a non-object', reference('برهان')],
    ['an unknown kind', reference({ kind: 'drawing', text: 'شكل' })],
    ['an image on a proof', reference({ kind: 'proof', text: 'برهان', image: FIGURE_IMAGE })],
    ['an image on a possible answer', reference({ kind: 'possible', text: 'إجابة', image: {} })],
    ['no text', reference({ kind: 'proof' })],
    ['an empty text', reference({ kind: 'proof', text: '' })],
    ['a blank text', reference({ kind: 'proof', text: ' \n ' })],
    ['a text over 4000 characters', reference({ kind: 'proof', text: 'ب'.repeat(4_001) })],
  ];
  it.each(refusedModelAnswers)('refuses a model answer %s', (_name, teacherGuide) => {
    expect(() => parse('g5.v11', teacherGuide)).toThrow(/teacherGuide items\[0\]\.modelAnswer/);
  });

  it('is covered by the digest when sent; a block without one digests as before', () => {
    const plain = parse('g5.v11', GUIDE);
    const items = GUIDE.items.map((item) =>
      item.status === 'reference' ? { ...item, modelAnswer: { kind: 'proof', text: PROOF } } : item,
    );
    const withModel = parse('g5.v11', { ...GUIDE, items });
    const otherText = parse('g5.v11', {
      ...GUIDE,
      items: GUIDE.items.map((item) =>
        item.status === 'reference'
          ? { ...item, modelAnswer: { kind: 'proof', text: `${PROOF} ∎` } }
          : item,
      ),
    });
    const otherKind = parse('g5.v11', {
      ...GUIDE,
      items: GUIDE.items.map((item) =>
        item.status === 'reference'
          ? { ...item, modelAnswer: { kind: 'possible', text: PROOF } }
          : item,
      ),
    });
    const digests = [plain, withModel, otherText, otherKind].map(canonicalRequestDigest);
    expect(new Set(digests).size).toBe(4);
    // Absent and `null` are the plain block's digest, byte for byte.
    const nulls = parse('g5.v11', {
      ...GUIDE,
      items: GUIDE.items.map((item) =>
        item.status === 'reference' ? { ...item, modelAnswer: null } : item,
      ),
    });
    expect(canonicalRequestDigest(nulls)).toBe(canonicalRequestDigest(plain));
  });

  it('keeps the model answer on the g5.v11 attempt snapshot and runner context', () => {
    const sent = {
      ...GUIDE,
      items: GUIDE.items.map((item) =>
        item.status === 'reference'
          ? { ...item, modelAnswer: { kind: 'proof', text: PROOF } }
          : item,
      ),
    };
    const { start, kafuo } = buildKafuoStartRequest(parse('g5.v11', sent), {
      tenantId: 'tenant-1',
      learningItem: { type: 'lesson', id: '901' },
    });
    expect(kafuo.teacherGuide).toEqual(sent);
    expect(toGenerationInputSnapshot(start).teacherGuide).toEqual(sent);
  });

  it('never reads a malformed model answer on g5.v10 (D-20)', () => {
    const request = parse('g5.v10', reference({ kind: 'figure' }, 'approved'));
    expect(request.teacherGuide).toBeUndefined();
  });
});

describe('teacherGuide figure model answers (owner, 17 Nov 2026)', () => {
  const figure = (modelAnswer: unknown, status = 'reference') => ({
    guideId: 'tg-1',
    items: [
      {
        contentUnitId: '6247',
        label: '1',
        status: 'approved',
        answer: { type: 'number', value: 3 },
      },
      { contentUnitId: '6250', label: '12', status, modelAnswer },
    ],
  });

  it('keeps the image key by key (the URL included), its note only when sent', () => {
    const request = parse(
      'g5.v11',
      figure({ kind: 'figure', image: { ...FIGURE_IMAGE, width: 640 }, extra: 'dropped' }),
    );
    expect(request.teacherGuide?.items[1]?.modelAnswer).toEqual({
      kind: 'figure',
      image: FIGURE_IMAGE,
    });
    const noted = parse(
      'g5.v11',
      figure({
        kind: 'figure',
        image: FIGURE_IMAGE,
        text: 'المستقيم يمر بالنقطتين (0، 1) و(2، 5).',
      }),
    );
    expect(noted.teacherGuide?.items[1]?.modelAnswer).toEqual({
      kind: 'figure',
      image: FIGURE_IMAGE,
      text: 'المستقيم يمر بالنقطتين (0، 1) و(2، 5).',
    });
    // D-20: a `null` note is absent, digested as never sent.
    const nullText = parse('g5.v11', figure({ kind: 'figure', image: FIGURE_IMAGE, text: null }));
    expect(nullText.teacherGuide?.items[1]?.modelAnswer).toEqual({
      kind: 'figure',
      image: FIGURE_IMAGE,
    });
    expect(canonicalRequestDigest(nullText)).toBe(
      canonicalRequestDigest(parse('g5.v11', figure({ kind: 'figure', image: FIGURE_IMAGE }))),
    );
  });

  const refused: Array<[string, unknown]> = [
    ['without an image', { kind: 'figure', text: 'رسمة' }],
    ['with a non-object image', { kind: 'figure', image: FIGURE_URL }],
    [
      'with an uppercase checksum',
      { kind: 'figure', image: { ...FIGURE_IMAGE, checksumSha256: 'A'.repeat(64) } },
    ],
    [
      'with a short checksum',
      { kind: 'figure', image: { ...FIGURE_IMAGE, checksumSha256: 'a'.repeat(63) } },
    ],
    ['with a JPEG', { kind: 'figure', image: { ...FIGURE_IMAGE, mimeType: 'image/jpeg' } }],
    ['with no size', { kind: 'figure', image: { ...FIGURE_IMAGE, sizeBytes: 0 } }],
    ['over 5,000,000 bytes', { kind: 'figure', image: { ...FIGURE_IMAGE, sizeBytes: 5_000_001 } }],
    ['with a fractional size', { kind: 'figure', image: { ...FIGURE_IMAGE, sizeBytes: 10.5 } }],
    ['with a string size', { kind: 'figure', image: { ...FIGURE_IMAGE, sizeBytes: '10' } }],
    ['without a URL', { kind: 'figure', image: { ...FIGURE_IMAGE, url: undefined } }],
    ['with a null URL', { kind: 'figure', image: { ...FIGURE_IMAGE, url: null } }],
    ['with an invalid URL', { kind: 'figure', image: { ...FIGURE_IMAGE, url: 'not a url' } }],
    [
      'with an http URL',
      { kind: 'figure', image: { ...FIGURE_IMAGE, url: 'http://r2.example.test/a.png?sig=x' } },
    ],
    ['with a blank note', { kind: 'figure', image: FIGURE_IMAGE, text: '  ' }],
    [
      'with a note over 4000 characters',
      { kind: 'figure', image: FIGURE_IMAGE, text: 'ب'.repeat(4_001) },
    ],
  ];
  it.each(refused)('refuses a figure %s, never echoing its URL', (_name, modelAnswer) => {
    let message = '';
    try {
      parse('g5.v11', figure(modelAnswer));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/teacherGuide items\[1\]\.modelAnswer/);
    expect(message).not.toContain('X-Amz-Signature');
    expect(message).not.toContain('sig=x');
  });

  it('refuses a figure on any status but reference', () => {
    expect(() =>
      parse('g5.v11', figure({ kind: 'figure', image: FIGURE_IMAGE }, 'missing')),
    ).toThrow(/modelAnswer is allowed only on a reference item/);
  });

  it('accepts the 5,000,000-byte bound', () => {
    const request = parse(
      'g5.v11',
      figure({ kind: 'figure', image: { ...FIGURE_IMAGE, sizeBytes: 5_000_000 } }),
    );
    expect(request.teacherGuide?.items[1]?.modelAnswer).toMatchObject({
      image: { sizeBytes: 5_000_000 },
    });
  });

  it('digests the drawing, never its URL; the snapshot never keeps the URL', () => {
    const sent = figure({ kind: 'figure', image: FIGURE_IMAGE });
    const request = parse('g5.v11', sent);
    const reminted = parse(
      'g5.v11',
      figure({ kind: 'figure', image: { ...FIGURE_IMAGE, url: `${FIGURE_URL}&X-Amz-Date=NEW` } }),
    );
    const other = parse(
      'g5.v11',
      figure({ kind: 'figure', image: { ...FIGURE_IMAGE, checksumSha256: 'b'.repeat(64) } }),
    );
    expect(canonicalRequestDigest(reminted)).toBe(canonicalRequestDigest(request));
    expect(canonicalRequestDigest(other)).not.toBe(canonicalRequestDigest(request));
    expect(canonicalRequestDigest(request)).not.toBe(
      canonicalRequestDigest(parse('g5.v11', figure(null))),
    );
    // The figure-free block is untouched: the same object reaches the digest and snapshot.
    const plain = parse('g5.v11', GUIDE).teacherGuide!;
    expect(teacherGuideSnapshotFacts(plain)).toBe(plain);
    const { start, kafuo } = buildKafuoStartRequest(request, {
      tenantId: 'tenant-1',
      learningItem: { type: 'lesson', id: '901' },
    });
    // The runner context alone holds the URL (in memory, to fetch the drawing) ...
    expect(kafuo.teacherGuide?.items[1]?.modelAnswer).toEqual({
      kind: 'figure',
      image: FIGURE_IMAGE,
    });
    // ... the persisted snapshot keeps the stable facts only, as the digest.
    const { url: _url, ...stable } = FIGURE_IMAGE;
    expect(toGenerationInputSnapshot(start).teacherGuide?.items[1]?.modelAnswer).toEqual({
      kind: 'figure',
      image: stable,
    });
    expect(JSON.stringify(start)).not.toContain('X-Amz-Signature=fig');
    expect(JSON.stringify(toGenerationInputSnapshot(start))).not.toContain('X-Amz-Signature');
    // The resumed request of the same attempt carries a re-minted URL and the same digest.
    expect(
      buildKafuoStartRequest(reminted, {
        tenantId: 'tenant-1',
        learningItem: { type: 'lesson', id: '901' },
      }).start.requestDigest,
    ).toBe(start.requestDigest);
  });
});

describe('teacherGuide digest and attempt', () => {
  it('is covered by the digest when sent, and absent leaves the digest unchanged', () => {
    const without = parseKafuoGenerationRequest(body('g5.v11')).request;
    const withGuide = parse('g5.v11', GUIDE);
    const changed = parse('g5.v11', {
      ...GUIDE,
      items: [{ ...GUIDE.items[0], answer: { type: 'number', value: 11.5, unit: 'ريال' } }],
    });
    expect(canonicalRequestDigest(withGuide)).not.toBe(canonicalRequestDigest(without));
    expect(canonicalRequestDigest(changed)).not.toBe(canonicalRequestDigest(withGuide));
    const { teacherGuide: _guide, ...plain } = withGuide;
    expect(canonicalRequestDigest(plain)).toBe(canonicalRequestDigest(without));
  });

  it('keeps the block on a g5.v11 attempt snapshot and runner context', () => {
    const request = parse('g5.v11', GUIDE);
    const { start, kafuo } = buildKafuoStartRequest(request, {
      tenantId: 'tenant-1',
      learningItem: { type: 'lesson', id: '901' },
    });
    expect(kafuo.teacherGuide).toEqual(GUIDE);
    expect(start.teacherGuide).toEqual(GUIDE);
    expect(toGenerationInputSnapshot(start).teacherGuide).toEqual(GUIDE);
  });

  it('ignores the block on g5.v10: the snapshot and context are as without it', () => {
    const aggregate = {
      tenantId: 'tenant-1',
      learningItem: { type: 'lesson' as const, id: '901' },
    };
    const sent = buildKafuoStartRequest(parse('g5.v10', GUIDE), aggregate);
    const plain = buildKafuoStartRequest(
      parseKafuoGenerationRequest(body('g5.v10')).request,
      aggregate,
    );
    expect(sent.kafuo.teacherGuide).toBeUndefined();
    expect(sent.start.teacherGuide).toBeUndefined();
    expect('teacherGuide' in toGenerationInputSnapshot(sent.start)).toBe(false);
    expect(sent.kafuo.requirement).toBe(plain.kafuo.requirement);
    const { requestDigest: _a, ...sentRest } = sent.start;
    const { requestDigest: _b, ...plainRest } = plain.start;
    expect(sentRest).toEqual(plainRest);
  });
});

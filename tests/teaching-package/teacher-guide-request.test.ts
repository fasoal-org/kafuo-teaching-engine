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

// Lesson 306 (2 Nov 2026): the outline answer check (F-2), the parse report
// (F-4) and their wiring into generateSceneOutlinesFromRequirements.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  MIN_REQUIRED_UNITS_FOR_SHORTFALL,
  OUTLINE_ANSWER_MALFORMED,
  OUTLINE_ANSWER_UNPARSABLE,
  findBookUnitShortfall,
  findMalformedOutlineEntries,
  generateSceneOutlinesFromRequirements,
  parseJsonResponse,
  parseJsonResponseWithInfo,
  type AICallFn,
  type SceneOutline,
} from '@openmaic/generation';

/** The 306 answer as the reader accepted it (trimmed to 3 of 14 nested slides). */
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/outline-306-nested-answer.json', import.meta.url), 'utf8'),
) as { parsed: [Record<string, unknown>, Record<string, unknown>] };
const [nestedAnswer, survivingSlide] = fixture.parsed;
const nestedSlides = nestedAnswer.outlines as SceneOutline[];

const requirement = { requirement: 'Teach inductive reasoning' };
const callReturning =
  (text: string): AICallFn =>
  async () =>
    text;

describe('findMalformedOutlineEntries (F-2, structure)', () => {
  it('flags the real 306 shape: a nested answer object plus one slide', () => {
    expect(findMalformedOutlineEntries(fixture.parsed)).toEqual([
      'entry #1 is a nested answer object (has outlines, languageDirective), not a scene',
    ]);
  });

  it('passes the well-formed slides of the same answer', () => {
    expect(findMalformedOutlineEntries([...nestedSlides, survivingSlide])).toEqual([]);
  });

  it('flags non-objects and entries without type or title', () => {
    expect(
      findMalformedOutlineEntries([
        'scene',
        null,
        [],
        { type: 'slide' },
        { title: 'T', type: '  ' },
        { languageDirective: 'x', type: 'slide', title: 'T' },
      ]),
    ).toEqual([
      'entry #1 is not a scene object',
      'entry #2 is not a scene object',
      'entry #3 is not a scene object',
      'entry #4 has no title',
      'entry #5 has no type',
      'entry #6 is a nested answer object (has languageDirective), not a scene',
    ]);
  });
});

describe('findBookUnitShortfall (F-2, book-structured requests)', () => {
  const plan = [
    { type: 'slide', title: 'a', sourceContentUnitIds: ['u1', 'u2'] },
    { type: 'slide', title: 'b', sourceContentUnitIds: [3] },
    { type: 'slide', title: 'c' },
  ];

  it('accepts a plan citing at least half of the required units', () => {
    expect(findBookUnitShortfall(plan, ['u1', 'u2', '3', 'u4', 'u5', 'u6'])).toBeNull();
  });

  it('refuses a plan citing fewer than half', () => {
    expect(findBookUnitShortfall(plan, ['u1', 'u2', 'u4', 'u5', 'u6'])).toBe(
      'the plan cites 2 of the 5 required book units (fewer than half)',
    );
  });

  it('is off with fewer than MIN_REQUIRED_UNITS_FOR_SHORTFALL required units', () => {
    expect(MIN_REQUIRED_UNITS_FOR_SHORTFALL).toBe(4);
    expect(findBookUnitShortfall([], undefined)).toBeNull();
    expect(findBookUnitShortfall([], [])).toBeNull();
    expect(findBookUnitShortfall([], ['a', 'b', 'c'])).toBeNull();
    expect(findBookUnitShortfall([], ['a', 'b', 'c', 'd'])).toMatch(/0 of the 4/);
  });

  it('counts only the surviving slide of the 306 shape (the nested slides are not scenes)', () => {
    const required = [
      ...nestedSlides.flatMap((slide) => slide.sourceContentUnitIds ?? []),
      ...((survivingSlide.sourceContentUnitIds as string[]) ?? []),
    ];
    expect(findBookUnitShortfall(fixture.parsed, required)).toMatch(/fewer than half/);
  });
});

describe('parseJsonResponseWithInfo (F-4)', () => {
  it('reports an exact parse', () => {
    expect(parseJsonResponseWithInfo('{"a":1}')).toEqual({
      value: { a: 1 },
      info: { extraction: 'exact', repair: 'none', reasoningPrefixStripped: false, exact: true },
    });
  });

  it('reports a code block', () => {
    expect(parseJsonResponseWithInfo('Here:\n```json\n{"a":1}\n```').info).toEqual({
      extraction: 'code-block',
      repair: 'none',
      reasoningPrefixStripped: false,
      exact: false,
    });
  });

  it('reports a balanced block after a reasoning prefix', () => {
    expect(parseJsonResponseWithInfo('<think>x</think> ok {"a":1} trailing').info).toEqual({
      extraction: 'balanced-block',
      repair: 'none',
      reasoningPrefixStripped: true,
      exact: false,
    });
  });

  it('reports a truncation fix', () => {
    const outcome = parseJsonResponseWithInfo('[{"a":1},{"b":2},{"c":');
    expect(outcome.value).toEqual([{ a: 1 }, { b: 2 }]);
    expect(outcome.info).toMatchObject({ extraction: 'whole-response', repair: 'truncation-fix' });
  });

  it('reports jsonrepair', () => {
    const outcome = parseJsonResponseWithInfo('{"a": "an "unescaped" quote"}');
    expect(outcome.info).toMatchObject({ repair: 'jsonrepair', exact: false });
  });

  it('a truncation fix can rebuild the 306 shape from an unclosed answer array', () => {
    const outcome = parseJsonResponseWithInfo(
      `[${JSON.stringify(nestedAnswer)},\n${JSON.stringify(survivingSlide)},\n{"id": "scene_16", "type": "sl`,
    );
    expect(outcome.info).toMatchObject({ repair: 'truncation-fix', exact: false });
    expect(outcome.value).toEqual(fixture.parsed);
  });

  it('keeps parseJsonResponse returns unchanged', () => {
    for (const text of [
      '{"a":1}',
      '```json\n[1,2]\n```',
      'null',
      'no json here',
      '[{"a":1},{"b"',
    ]) {
      expect(parseJsonResponse(text)).toEqual(parseJsonResponseWithInfo(text).value);
    }
  });
});

describe('generateSceneOutlinesFromRequirements with rejectMalformedAnswer', () => {
  it('refuses the 306 shape read as written as a typed bad answer', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      requirement,
      undefined,
      undefined,
      callReturning(JSON.stringify(fixture.parsed)),
      { rejectMalformedAnswer: true, collectCorrectableIssues: true },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(new RegExp(`^${OUTLINE_ANSWER_MALFORMED}: `));
    expect(result.badAnswer?.code).toBe(OUTLINE_ANSWER_MALFORMED);
    expect(result.answer?.parse?.exact).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it('refuses a repaired broken answer as unparsable, never as success', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      requirement,
      undefined,
      undefined,
      callReturning(
        `[${JSON.stringify(nestedAnswer)},\n${JSON.stringify(survivingSlide)},\n{"id": "scene_16", "type": "sl`,
      ),
      { rejectMalformedAnswer: true, collectCorrectableIssues: true },
    );
    expect(result.success).toBe(false);
    expect(result.badAnswer?.code).toBe(OUTLINE_ANSWER_UNPARSABLE);
    expect(result.answer?.parse?.repair).toBe('truncation-fix');
  });

  it('refuses a well-formed plan that covers fewer than half of the required book units', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      requirement,
      undefined,
      undefined,
      callReturning(JSON.stringify({ languageDirective: 'ar', outlines: [survivingSlide] })),
      {
        rejectMalformedAnswer: true,
        requiredSourceUnitIds: ['4030', '4031', '4032', '4033'],
      },
    );
    expect(result.badAnswer).toEqual({
      code: OUTLINE_ANSWER_MALFORMED,
      reasons: ['the plan cites 1 of the 4 required book units (fewer than half)'],
    });
  });

  it('a broken answer read from a ```json fence (no repair) is malformed, not unparsable', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      requirement,
      undefined,
      undefined,
      callReturning(`Here is the plan:\n\`\`\`json\n${JSON.stringify(fixture.parsed)}\n\`\`\``),
      { rejectMalformedAnswer: true },
    );
    expect(result.answer?.parse).toMatchObject({ extraction: 'code-block', repair: 'none' });
    expect(result.badAnswer?.code).toBe(OUTLINE_ANSWER_MALFORMED);
  });

  it('a fenced well-formed answer is accepted', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      requirement,
      undefined,
      undefined,
      callReturning(`\`\`\`json\n${JSON.stringify(nestedAnswer)}\n\`\`\``),
      { rejectMalformedAnswer: true },
    );
    expect(result.success).toBe(true);
    expect(result.answer?.parse).toMatchObject({ extraction: 'code-block', repair: 'none' });
  });

  it('an answer with no outline array is a typed unparsable bad answer', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      requirement,
      undefined,
      undefined,
      callReturning('{"languageDirective": "ar", "courseTitle": "x"}'),
      { rejectMalformedAnswer: true },
    );
    expect(result.success).toBe(false);
    // Valid JSON read without repair, wrong shape: malformed.
    expect(result.badAnswer).toEqual({
      code: OUTLINE_ANSWER_MALFORMED,
      reasons: ['the answer holds no outline array'],
    });
  });

  it('prose with no JSON plan is a typed unparsable bad answer', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      requirement,
      undefined,
      undefined,
      callReturning('Sorry, I cannot plan this lesson.'),
      { rejectMalformedAnswer: true },
    );
    expect(result.success).toBe(false);
    // jsonrepair "reads" the prose (as an array of strings): never a plan.
    expect(result.answer?.parse?.repair).toBe('jsonrepair');
    expect(result.badAnswer?.code).toBe(OUTLINE_ANSWER_UNPARSABLE);
    expect(result.badAnswer?.reasons.length).toBeGreaterThan(0);
  });

  it('without the option an answer with no outline array fails exactly as before', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      requirement,
      undefined,
      undefined,
      callReturning('{"languageDirective": "ar"}'),
    );
    expect(result).toEqual({ success: false, error: 'Failed to parse scene outlines response' });
  });

  it('accepts a well-formed answer and reports its exact parse', async () => {
    const aiCall = vi.fn(callReturning(JSON.stringify({ ...nestedAnswer })));
    const result = await generateSceneOutlinesFromRequirements(
      requirement,
      undefined,
      undefined,
      aiCall,
      { rejectMalformedAnswer: true, collectCorrectableIssues: true },
    );
    expect(result.success).toBe(true);
    expect(result.data?.outlines).toHaveLength(3);
    expect(result.badAnswer).toBeUndefined();
    expect(result.answer).toEqual({
      parse: { extraction: 'exact', repair: 'none', reasoningPrefixStripped: false, exact: true },
      malformed: [],
    });
  });

  it('leaves every other caller exactly as before: no check, no report', async () => {
    const result = await generateSceneOutlinesFromRequirements(
      requirement,
      undefined,
      undefined,
      callReturning(JSON.stringify(fixture.parsed)),
      { collectCorrectableIssues: true },
    );
    expect(result.success).toBe(true);
    expect(result.data?.outlines).toHaveLength(2);
    expect('answer' in result).toBe(false);
    expect('badAnswer' in result).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalMismatchQuotes,
  detectSacredQuotes,
  findHadithSpans,
  sacredPolicyMode,
  sacredPolicyModeFor,
  singleSceneSacredFindings,
  stripSacredSpeech,
  findPinnedSacredTextEdits,
  readSacredQuotePins,
  EXERCISE_NEUTRAL_LINE,
  TRY_IT_NEUTRAL_LINE,
  SACRED_IMAGE_DIRECTIVE,
  SACRED_NARRATION_LINE,
  SACRED_TEXT_ALTERED,
  SACRED_TEXT_COMPLETION_ITEM,
  SACRED_TEXT_EXPLAINED,
  SACRED_TEXT_IN_QUIZ_OPTION,
  SACRED_TEXT_NARRATED,
  SACRED_TEXT_PINNED,
  SACRED_TEXT_SPLIT,
  SACRED_TEXT_WITH_AUDIO,
  SacredQuotesContractError,
  sacredQuotesFromManifest,
  stripSacredNarration,
  stripSacredTextFromImagePrompt,
  stripSacredTextFromMediaRequests,
  usedSacredQuotePins,
  validateSacredText,
  pinnedQuotesIn,
  sacredQuestionFindings,
  shownSceneTexts,
  detectSacredQuotesByParagraph,
  detectSacredText,
  sacredAddedTextFindings,
  shownQuotesIn,
  exerciseSceneIdsOf,
  SACRED_TEXT_IN_EXERCISE,
  stripSacredExerciseItems,
  withoutSacredItems,
  type SacredQuote,
  type SacredSceneLike,
} from '@/lib/server/teaching-package/sacred-text';

const VERSE = '﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ مِنْهُ آيَاتٌ مُّحْكَمَاتٌ﴾';
/** sha256 of VERSE's UTF-8 bytes, computed outside the TE (`shasum -a 256`). */
const VERSE_SHA = 'b9adc062bb1457563c61df31452461aafb708b5685bf89bdba61934c9a9c5421';
const HADITH_CORE = 'إنما الأعمال بالنيات، وإنما لكل امرئ ما نوى';
const HADITH = `«${HADITH_CORE}»`;

const quotes: SacredQuote[] = sacredQuotesFromManifest([
  {
    id: 'cu-1',
    normalizedText: `قال تعالى: ${VERSE} سورة آل عمران الآية: 7`,
    sacred_quotes: [
      {
        kind: 'quran',
        text: VERSE,
        reference: 'سورة آل عمران الآية: 7',
        source_block_id: 41,
        sha256: VERSE_SHA,
        canonical_status: 'matched',
      },
      {
        kind: 'hadith',
        text: HADITH,
        reference: 'متفق عليه',
        source_block_id: 42,
        sha256: 'x',
        canonical_status: 'unchecked',
      },
    ],
  },
]);

function slide(id: string, html: string[], speech: string[] = []): SacredSceneLike {
  return {
    id,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        elements: html.map((content, index) => ({ id: `t${index}`, type: 'text', content })),
      },
    },
    actions: speech.map((text, index) => ({ id: `s${index}`, type: 'speech', text })),
  };
}

function quiz(id: string, question: string, options: string[]): SacredSceneLike {
  return {
    id,
    type: 'quiz',
    content: {
      type: 'quiz',
      questions: [
        {
          id: 'q1',
          type: 'single',
          question,
          options: options.map((label, index) => ({ label, value: String(index) })),
          answer: ['0'],
        },
      ],
    },
    actions: [],
  };
}

const codes = (scenes: SacredSceneLike[]) =>
  validateSacredText(scenes, quotes).map((finding) => finding.code);

describe('sacred quotes input contract', () => {
  it('reads the export field, keeps block ids as strings and recomputes the sha256', () => {
    expect(quotes).toHaveLength(2);
    expect(quotes[0]).toMatchObject({
      kind: 'quran',
      text: VERSE,
      sourceBlockId: '41',
      sha256: VERSE_SHA,
      canonicalStatus: 'matched',
      contentUnitId: 'cu-1',
      origin: 'export',
    });
    // A wrong wire digest never replaces the text's own.
    expect(quotes[1]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects ﴿…﴾ spans and attributed hadith when the field is absent (older backends)', () => {
    const detected = sacredQuotesFromManifest([
      {
        id: 'cu-9',
        normalizedText: `قال تعالى: ${VERSE} (سورة آل عمران الآية: 7)\nقال رسول الله ﷺ: ${HADITH}`,
        blocks: [{ id: '7', text: `قال تعالى: ${VERSE}` }],
      },
    ]);
    // A hadith's canonical text is its trimmed inner quote, without «» (S-0).
    expect(detected.map((quote) => [quote.kind, quote.text, quote.origin])).toEqual([
      ['quran', VERSE, 'detected'],
      ['hadith', HADITH_CORE, 'detected'],
    ]);
    expect(detected[0]!.sha256).toBe(VERSE_SHA);
    expect(detected[0]!.sourceBlockId).toBe('7');
    expect(detected[0]!.reference).toContain('سورة آل عمران');
  });

  it('trusts an empty field and refuses a malformed one', () => {
    expect(
      sacredQuotesFromManifest([{ id: 'cu-2', normalizedText: VERSE, sacred_quotes: [] }]),
    ).toEqual([]);
    expect(() =>
      sacredQuotesFromManifest([{ id: 'cu-3', sacred_quotes: [{ kind: 'poem', text: 'x' }] }]),
    ).toThrow(SacredQuotesContractError);
    expect(() => sacredQuotesFromManifest([{ id: 'cu-4', sacred_quotes: 'nope' }])).toThrow(
      SacredQuotesContractError,
    );
  });

  it('keeps the hadith marker narrow: an ordinary «…» quotation is not a hadith', () => {
    expect(findHadithSpans('قال المعلم: «الفاعل مرفوع دائمًا»')).toEqual([]);
    expect(findHadithSpans('نقرأ في الكتاب «المبتدأ والخبر»')).toEqual([]);
    // A bare name without ﷺ or a speech verb is not an attribution.
    expect(findHadithSpans('من صفات النبي «الأمين»')).toEqual([]);
    expect(findHadithSpans('كان رسول الله «قدوة»')).toEqual([]);
    expect(findHadithSpans(`قال النبي: ${HADITH}`)).toHaveLength(1);
    expect(findHadithSpans(`أن النبي ﷺ قال: ${HADITH}`)).toHaveLength(1);
    // The sixth shared form needs the honorific: «عن النبي ﷺ أنه قال».
    expect(findHadithSpans(`عن النبي ﷺ أنه قال: ${HADITH}`)).toHaveLength(1);
    expect(findHadithSpans(`عن النبي أنه قال: ${HADITH}`)).toEqual([]);
  });

  it('reads a hadith exported with or without its quote marks as one canonical text', () => {
    const [withMarks] = sacredQuotesFromManifest([
      { id: 'cu-5', sacred_quotes: [{ kind: 'hadith', text: ` ${HADITH} ` }] },
    ]);
    const [bare] = sacredQuotesFromManifest([
      { id: 'cu-6', sacred_quotes: [{ kind: 'hadith', text: HADITH_CORE }] },
    ]);
    expect(withMarks!.text).toBe(HADITH_CORE);
    expect(withMarks!.sha256).toBe(bare!.sha256);
  });

  it('flags a canonical mismatch for the fail-closed acquisition (S-6)', () => {
    const flagged = sacredQuotesFromManifest([
      {
        id: 'cu-7',
        sacred_quotes: [{ kind: 'quran', text: VERSE, canonical_status: 'mismatch' }],
      },
    ]);
    expect(canonicalMismatchQuotes(flagged)).toHaveLength(1);
    expect(canonicalMismatchQuotes(quotes)).toEqual([]);
  });
});

describe('validateSacredText', () => {
  it('passes the exact verse with its reference, also inside inline HTML', () => {
    expect(
      codes([
        slide('a', [`<p>عيّن التابع في قوله تعالى: ${VERSE}</p><p>سورة آل عمران الآية: 7</p>`]),
      ]),
    ).toEqual([]);
    const wrapped = VERSE.replace('الْكِتَابَ', '<strong>الْكِتَابَ</strong>');
    expect(codes([slide('b', [`<p>${wrapped}</p>`])])).toEqual([]);
  });

  it('fails one changed letter', () => {
    const changed = VERSE.replace('أَنزَلَ', 'أَنزَلْ');
    expect(codes([slide('a', [changed])])).toEqual([SACRED_TEXT_ALTERED]);
  });

  it('fails an invented verse and an invented hadith', () => {
    expect(codes([slide('a', ['﴿وَقُلْ رَبِّ زِدْنِي فَهْمًا﴾'])])).toEqual([SACRED_TEXT_ALTERED]);
    expect(codes([slide('b', ['قال رسول الله ﷺ: «اطلبوا النحو ولو في الصين»'])])).toEqual([
      SACRED_TEXT_ALTERED,
    ]);
  });

  it('allows a cut marked with «…» and fails one without it', () => {
    expect(codes([slide('a', ['﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ …﴾'])])).toEqual([]);
    expect(codes([slide('b', ['﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ﴾'])])).toEqual([
      SACRED_TEXT_ALTERED,
    ]);
  });

  it('fails an added explanation sentence', () => {
    expect(codes([slide('a', [`${VERSE} أي: إن الله أنزل القرآن`])])).toEqual([
      SACRED_TEXT_EXPLAINED,
    ]);
    expect(codes([slide('b', [VERSE], ['معنى الآية أن الكتاب فيه آيات واضحة'])])).toEqual([
      SACRED_TEXT_EXPLAINED,
    ]);
  });

  it('fails a verse split across slides', () => {
    const [first, second] = [VERSE.slice(0, 20), VERSE.slice(20)];
    // The second half also holds a five-word run of the verse outside any
    // span (S-2), so it is an altered copy as well.
    expect(codes([slide('a', [first]), slide('b', [second])])).toEqual([
      SACRED_TEXT_SPLIT,
      SACRED_TEXT_SPLIT,
      SACRED_TEXT_ALTERED,
    ]);
  });

  it('fails a quiz distractor verse and keeps the stem quote allowed in its options', () => {
    const changed = VERSE.replace('آيَاتٌ', 'كَلِمَاتٌ');
    const found = codes([
      quiz('q', `ما إعراب «الكتاب» في قوله تعالى: ${VERSE}؟`, [changed, 'مفعول به']),
    ]);
    expect(found).toContain(SACRED_TEXT_IN_QUIZ_OPTION);
    expect(found).toContain(SACRED_TEXT_ALTERED);
    expect(codes([quiz('r', `في قوله تعالى: ${VERSE} ما التابع؟`, [VERSE, 'لا تابع'])])).toEqual(
      [],
    );
  });

  it('fails a "complete the verse" item', () => {
    expect(codes([quiz('q', 'أكمل الآية: ﴿هُوَ الَّذِي أَنزَلَ ____﴾', ['الكتاب'])])).toContain(
      SACRED_TEXT_COMPLETION_ITEM,
    );
  });

  it('fails narration that reads the verse, and audio beside a verse', () => {
    expect(codes([slide('a', [VERSE], [`قال تعالى ${VERSE}`])])).toEqual([SACRED_TEXT_NARRATED]);
    expect(
      codes([slide('b', [VERSE], ['هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ مِنْهُ آيَاتٌ'])]),
    ).toEqual([SACRED_TEXT_NARRATED]);
    const withAudio = slide('c', [VERSE]);
    (withAudio.content as { canvas: { elements: unknown[] } }).canvas.elements.push({
      id: 'a1',
      type: 'audio',
      src: 'x.mp3',
    });
    expect(codes([withAudio])).toEqual([SACRED_TEXT_WITH_AUDIO]);
  });

  it('passes a lesson with no quotes at all', () => {
    expect(codes([slide('a', ['الفاعل اسم مرفوع'], ['لنتعرف على الفاعل'])])).toEqual([]);
  });
});

describe('narration and image stripping', () => {
  it('replaces a spoken verse and hadith with the owner lines before TTS', () => {
    const scenes = [
      slide(
        'a',
        [VERSE],
        [
          `قال تعالى: ${VERSE}. لنحدد التابع.`,
          `قال رسول الله ﷺ: ${HADITH} نلاحظ أداة الحصر.`,
          'هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ مِنْهُ آيَاتٌ مُّحْكَمَاتٌ',
          // S-4: a plain-word run (no brackets) is replaced by the same rule the check uses.
          'نقرأ الآن: أنزل عليك الكتاب منه آيات محكمات! ثم نحدد النعت.',
        ],
      ),
    ];
    expect(stripSacredNarration(scenes, quotes)).toBe(4);
    const spoken = (scenes[0]!.actions as Array<{ text: string }>).map((action) => action.text);
    // S-4: the WHOLE containing sentence becomes the owner's line.
    expect(spoken[0]).toBe(`${SACRED_NARRATION_LINE.quran}. لنحدد التابع.`);
    expect(spoken[1]).toBe(`${SACRED_NARRATION_LINE.hadith}.`);
    expect(spoken[2]).toBe(SACRED_NARRATION_LINE.quran);
    expect(spoken[3]).toBe(`${SACRED_NARRATION_LINE.quran}! ثم نحدد النعت.`);
    expect(validateSacredText(scenes, quotes)).toEqual([]);
  });

  it('never leaves a line the narration check would still refuse (S-4)', () => {
    const inputs = [
      `أولًا ${VERSE.slice(0, 25)} ثم نكمل`,
      `قال النبي ﷺ: «${HADITH_CORE}`,
      `وقال ﷺ: ${HADITH}. وهذا أسلوب حصر.`,
      'هو الذي أنزل عليك الكتاب. منه آيات محكمات.',
      `${VERSE} ${VERSE}`,
    ];
    for (const text of inputs) {
      const scene = slide('n', [VERSE], [stripSacredSpeech(text, quotes)]);
      expect(
        validateSacredText([scene], quotes).map((finding) => finding.code),
        text,
      ).not.toContain(SACRED_TEXT_NARRATED);
    }
    expect(stripSacredSpeech('لنحدد التابع في الجملة.', quotes)).toBe('لنحدد التابع في الجملة.');
  });

  it('keeps quote text out of image prompts and forbids scripture in the image', () => {
    const prompt = `An open book showing ${VERSE} in gold`;
    const stripped = stripSacredTextFromImagePrompt(prompt, quotes);
    expect(stripped).not.toContain('أَنزَلَ');
    expect(stripped).not.toMatch(/[﴾﴿]/);
    expect(stripped).toContain(SACRED_IMAGE_DIRECTIVE);
    expect(stripSacredTextFromImagePrompt('A calligraphy of a Quran verse', quotes)).toContain(
      SACRED_IMAGE_DIRECTIVE,
    );
    expect(stripSacredTextFromImagePrompt('A red apple on a table', quotes)).toBe(
      'A red apple on a table',
    );
    const outlines = [{ mediaGenerations: [{ prompt }, { prompt: 'A tree' }] }];
    expect(stripSacredTextFromMediaRequests(outlines, quotes)).toBe(1);
    expect(outlines[0]!.mediaGenerations[1]!.prompt).toBe('A tree');
  });
});

describe('pipeline wiring (source pins)', () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');

  it('L-2: single-scene paths decide the policy mode per lesson (pins), like the planner', () => {
    expect(read('lib/server/teaching-package/regenerate-one-scene.ts')).toContain(
      'sacredPolicyModeFor({ subjectCode: input.stage.subjectCode, pins: sacred.pins })',
    );
    expect(read('lib/server/teaching-package/insert-one-scene.ts')).toContain(
      'sacredPolicyModeFor({ subjectCode: stage.subjectCode, pins: input.sacred.pins })',
    );
    // A lesson with pins gets the full block even when this Scene shows no quote.
    expect(sacredPolicyModeFor({ subjectCode: 'PHYSICS', pins: [{}] })).toBe('full');
  });

  it('gates every Kafuo run on the generated Scenes and pauses on the scene-regeneration path', () => {
    const runner = read('lib/server/teaching-package/generation-runner.ts');
    expect(runner).toContain(
      'validateSacredText(result.scenes, sacredQuotes, sacredExerciseScope)',
    );
    expect(runner).toContain('mode: sacredPolicyMode(sacredQuotes, kafuo.subjectCode)');
    const gate = runner.slice(runner.indexOf('validateSacredText(result.scenes'));
    expect(gate.slice(0, 2500)).toContain('SACRED_TEXT_ALTERED');
    expect(gate.slice(0, 2500)).toContain("phase: 'scenes'");
    expect(gate.slice(0, 2500)).toContain('pendingOutlineIds: pending');
  });

  it('strips media prompts before media and narration before TTS', () => {
    const generation = read('lib/server/classroom-generation.ts');
    const media = generation.indexOf('stripSacredTextFromMediaRequests(freshOutlines');
    const mediaPhase = generation.indexOf('// Phase: Media generation');
    const narration = generation.indexOf('stripSacredNarration(freshScenes');
    const ttsPhase = generation.indexOf('// Phase: TTS generation');
    expect(media).toBeGreaterThan(0);
    expect(media).toBeLessThan(mediaPhase);
    expect(narration).toBeGreaterThan(mediaPhase);
    expect(narration).toBeLessThan(ttsPhase);
  });
});

describe('integrity pins and the editor refusal', () => {
  const scenes = [slide('a', [`في قوله تعالى: ${VERSE}`])];
  const pins = usedSacredQuotePins(scenes, quotes);

  it('pins every book quote with sha256 and block id, marking the ones the package shows', () => {
    expect(pins[0]).toEqual({
      used: true,
      kind: 'quran',
      sha256: VERSE_SHA,
      sourceBlockId: '41',
      contentUnitId: 'cu-1',
      reference: 'سورة آل عمران الآية: 7',
    });
    expect(pins[1]).toMatchObject({ used: false, kind: 'hadith', sourceBlockId: '42' });
    expect(readSacredQuotePins(JSON.parse(JSON.stringify(pins)))).toEqual(pins);
    expect(readSacredQuotePins(undefined)).toBeNull();
  });

  it('accepts an edit that keeps the pinned verse and refuses one that changes it', () => {
    expect(findPinnedSacredTextEdits([slide('a', [`عنوان جديد ${VERSE}`])], pins)).toEqual([]);
    // Another book quote, exactly as printed, may be shown too.
    expect(findPinnedSacredTextEdits([slide('h', [`قال رسول الله ﷺ: ${HADITH}`])], pins)).toEqual(
      [],
    );
    const changed = VERSE.replace('مُّحْكَمَاتٌ', 'مُحكمات');
    expect(
      findPinnedSacredTextEdits([slide('a', [changed])], pins).map((finding) => finding.code),
    ).toEqual([SACRED_TEXT_PINNED]);
    expect(
      findPinnedSacredTextEdits([slide('a', [VERSE.slice(0, 15)])], pins).map((f) => f.code),
    ).toEqual([SACRED_TEXT_SPLIT]);
    expect(
      findPinnedSacredTextEdits([slide('a', [VERSE], [VERSE])], pins).map((f) => f.code),
    ).toEqual([SACRED_TEXT_NARRATED]);
    // S-5: plain spoken words of the Scene's pinned verse are refused too.
    expect(
      findPinnedSacredTextEdits(
        [slide('a', [VERSE], ['هو الذي أنزل عليك الكتاب منه آيات'])],
        pins,
      ).map((f) => f.code),
    ).toEqual([SACRED_TEXT_NARRATED]);
  });

  it('pins a faithful «…» cut the package shows, so an unchanged save passes', () => {
    const cut = '﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ …﴾';
    const cutPins = usedSacredQuotePins([slide('c', [cut])], quotes);
    expect(cutPins).toHaveLength(3);
    expect(findPinnedSacredTextEdits([slide('c', [cut])], cutPins)).toEqual([]);
    expect(findPinnedSacredTextEdits([slide('c', [cut])], pins).map((f) => f.code)).toEqual([
      SACRED_TEXT_PINNED,
    ]);
  });

  it('checks a single regenerated Scene against its OWN pinned quotes (S-5)', () => {
    // No quote was recovered for the prompt; the candidate shows the pinned
    // hadith and its narration reads it in plain words.
    const candidate = slide(
      'r',
      [`قال رسول الله ﷺ: ${HADITH}`],
      ['إنما الأعمال بالنيات وإنما لكل امرئ ما نوى'],
    );
    expect(singleSceneSacredFindings(candidate, pins, []).map((f) => f.code)).toEqual([
      SACRED_TEXT_NARRATED,
    ]);
    // S-2 findings are no longer filtered out of the one-scene checks.
    const copied = slide('s', ['هو الذي أنزل عليك الكتاب منه آيات محكمات']);
    expect(singleSceneSacredFindings(copied, pins, quotes).map((f) => f.code)).toEqual([
      SACRED_TEXT_ALTERED,
    ]);
  });
});

describe('review fixes S-2, S-3, S-6, S-9', () => {
  it('S-2: fails a verse copied without its brackets, or a five-word run of it', () => {
    expect(codes([slide('a', ['قال تعالى: هو الذي أنزل عليك الكتاب منه آيات محكمات'])])).toEqual([
      SACRED_TEXT_ALTERED,
    ]);
    expect(
      codes([slide('b', ['في الآية: أَنزَلَ عَلَيْكَ الْكِتَابَ مِنْهُ آيَاتٌ وهي جملة'])]),
    ).toEqual([SACRED_TEXT_ALTERED]);
    expect(
      codes([quiz('q', 'ما نوع التابع؟', ['إنما الأعمال بالنيات وإنما لكل امرئ', 'نعت'])]),
    ).toContain(SACRED_TEXT_ALTERED);
    // Single words of the verse in a grammar analysis are not a copy.
    expect(codes([slide('c', [`${VERSE}\nالكتاب: مفعول به، آيات: مبتدأ مؤخر`])])).toEqual([]);
  });

  it('S-3: only the same sentence, ~40 characters on; «أي:» only directly after', () => {
    expect(codes([slide('a', [`${VERSE} معنى الآية أن الكتاب نزل`])])).toEqual([
      SACRED_TEXT_EXPLAINED,
    ]);
    expect(codes([slide('b', [`${VERSE} نوعه: نعت، أي: صفة لما قبله`])])).toEqual([]);
    expect(codes([slide('c', [`${VERSE}. يقصد بها في الدرس الجملة الاسمية`])])).toEqual([]);
    expect(codes([slide('d', [`${VERSE} يقصد به الفاعل، والمراد التابع`])])).toEqual([]);
  });

  it('S-3: a realistic G11 «التوابع» grammar slide (stored block 56795) passes', () => {
    const block = (
      JSON.parse(
        readFileSync(
          path.join(process.cwd(), 'tests/fixtures/sacred-text/contract_cases.json'),
          'utf8',
        ),
      ) as Array<{ id: string; text: string }>
    ).find((entry) => entry.id === 'real_block_56795_g11_four_verses')!.text;
    const g11 = detectSacredQuotes({ id: 'cu-g11', normalizedText: block });
    expect(g11).toHaveLength(4);
    const [v1, v2, v3, v4] = g11.map((quote) => quote.text);
    const scene: SacredSceneLike = {
      ...slide(
        'g11',
        [
          '<p><strong>التوابع: البدل والتوكيد</strong></p>',
          '<p>المراد بالتابع: كل اسم يتبع ما قبله في إعرابه، وتفسير ذلك أن حكمه حكم متبوعه.</p>',
          `<p>${v1} (1) نوعه: بدل اشتمال، وتفسير ذلك نحويًا أن «قتال» تبع «الشهر»</p>`,
          `<p>${v2} (2) يقصد به في الإعراب: «هارون» بدل من «أخي»</p>`,
          `<p>${v3} (3) المراد بالبدل هنا «النار» من «الأخدود»</p>`,
          `<p>${v4} (4) التابع: «كلهم أجمعون»، نوعه: توكيد معنوي</p>`,
          '<p>عيّن التابع والمتبوع في الأمثلة السابقة، وبيّن نوعه.</p>',
        ],
        ['لنتأمل الأمثلة المعروضة ونحدد نوع التابع في كل جملة.'],
      ),
      title: 'التوابع في الأمثلة القرآنية',
    };
    expect(validateSacredText([scene], g11)).toEqual([]);
  });

  it('S-6: a «…» cut needs whole-word pieces of two or more words', () => {
    const passes = [
      '﴿… أَنزَلَ عَلَيْكَ …﴾',
      '﴿هُوَ الَّذِي … مِنْهُ آيَاتٌ مُّحْكَمَاتٌ﴾',
      '﴿… مِنْهُ آيَاتٌ مُّحْكَمَاتٌ﴾',
    ];
    for (const cut of passes) expect(codes([slide('a', [cut])]), cut).toEqual([]);
    const fails = [
      '﴿هُوَ … الْكِتَابَ﴾',
      '﴿هُوَ الَّذِي أَنزَ …﴾',
      '﴿هُوَ الَّذِي … عَلَيْكَ الْكِتَابَ … مُّحْكَمَاتٌ﴾',
      '﴿… أَنزَلَ عَلَيْكَ﴾',
      '﴿هُوَ الَّذِي … الَّذِي أَنزَلَ …﴾',
    ];
    for (const cut of fails) expect(codes([slide('b', [cut])]), cut).toEqual([SACRED_TEXT_ALTERED]);
  });

  it('S-6: checks the Scene title and every whiteboard text action', () => {
    const changed = VERSE.replace('أَنزَلَ', 'أَنزَلْ');
    expect(codes([{ ...slide('a', ['نص']), title: changed }])).toEqual([SACRED_TEXT_ALTERED]);
    for (const action of [
      { type: 'wb_draw_table', data: [['الجملة', changed]] },
      { type: 'wb_draw_code', code: changed, language: 'text' },
      { type: 'wb_draw_chart', data: { labels: [changed], series: [[1]] } },
    ]) {
      const scene = { id: 'w', type: 'slide', content: {}, actions: [{ id: 'x', ...action }] };
      expect(codes([scene]), action.type).toEqual([SACRED_TEXT_ALTERED]);
    }
  });

  it('S-9: the full block for quotes or an ARABIC subject, else the short line', () => {
    expect(sacredPolicyMode([], 'MATH')).toBe('short');
    expect(sacredPolicyMode([], null)).toBe('short');
    expect(sacredPolicyMode([], ' arabic ')).toBe('full');
    expect(sacredPolicyMode(quotes, 'PHYSICS')).toBe('full');
  });

  it('S-9: scripture words in an image prompt use Arabic word boundaries', () => {
    expect(stripSacredTextFromImagePrompt('صورة لمدينة الحديثة', [])).toBe('صورة لمدينة الحديثة');
    expect(stripSacredTextFromImagePrompt('رسم يوضح الحديث', [])).toContain(SACRED_IMAGE_DIRECTIVE);
    expect(stripSacredTextFromImagePrompt('لوحة بالقرآن الكريم', [])).toContain(
      SACRED_IMAGE_DIRECTIVE,
    );
  });
});

describe('re-review fixes H-1, H-2, M-1 to M-6, L-1 to L-3', () => {
  const fixture = JSON.parse(
    readFileSync(
      path.join(process.cwd(), 'tests/fixtures/sacred-text/contract_cases.json'),
      'utf8',
    ),
  ) as Array<{ id: string; text: string }>;
  const block = (id: string) => fixture.find((entry) => entry.id === id)!.text;

  /** The fixture verses read in normal (imla'i) spelling, without brackets. */
  const NORMAL_SPELLING = [
    'وأخي هارون هو أفصح مني لسانا',
    'قتل أصحاب الأخدود النار ذات الوقود',
    'فسجد الملائكة كلهم أجمعون إلا إبليس أبى أن يكون مع الساجدين',
    'يسألونك عن الشهر الحرام قتال فيه قل قتال فيه كبير وصد عن سبيل الله',
  ];
  const POETRY = 'ولن يلبث العصران يوم وليلة إذا طلبا أن يدركا ما تيمما';

  describe.each(['real_block_56795_g11_four_verses', 'real_block_58797_g11_four_verses_reparsed'])(
    'H-1 Uthmani folding, %s',
    (id) => {
      const g11 = detectSacredQuotes({ id: 'cu-g11', normalizedText: block(id) });
      const verses = g11.map((quote) => quote.text);
      const g11Codes = (scenes: SacredSceneLike[]) =>
        validateSacredText(scenes, g11).map((finding) => finding.code);

      it('flags narration that reads a verse in normal spelling, and the repair removes it', () => {
        expect(g11).toHaveLength(4);
        for (const [index, spoken] of NORMAL_SPELLING.entries()) {
          const scene = slide(
            `n${index}`,
            [verses[index === 3 ? 0 : index + 1]!],
            [`لاحظ الجملة: ${spoken}.`],
          );
          expect(g11Codes([scene]), spoken).toEqual([SACRED_TEXT_NARRATED]);
          expect(stripSacredNarration([scene], g11)).toBe(1);
          expect(g11Codes([scene]), spoken).toEqual([]);
          expect((scene.actions as Array<{ text: string }>)[0]!.text).toBe(
            `${SACRED_NARRATION_LINE.quran}.`,
          );
        }
      });

      it('flags a verse shown without brackets in normal spelling', () => {
        for (const shown of NORMAL_SPELLING) {
          expect(g11Codes([slide('u', [`قال تعالى: ${shown}`])]), shown).toEqual([
            SACRED_TEXT_ALTERED,
          ]);
        }
      });

      it('passes the exact Uthmani verses, and never folds the shown text', () => {
        const scene = slide('e', verses, ['لنحدد التابع في كل مثال.']);
        expect(g11Codes([scene])).toEqual([]);
        // The fold is for word runs only: a bracketed verse in normal spelling is altered.
        expect(g11Codes([slide('f', [`﴿${NORMAL_SPELLING[0]}﴾`])])).toEqual([SACRED_TEXT_ALTERED]);
      });

      it('does not flag the poetry lines of the same block read aloud (false-pause control)', () => {
        const scene = slide('p', [verses[1]!, POETRY], [`نقرأ البيت: ${POETRY}.`]);
        expect(g11Codes([scene])).toEqual([]);
        expect(stripSacredSpeech(`نقرأ البيت: ${POETRY}.`, g11)).toBe(`نقرأ البيت: ${POETRY}.`);
      });
    },
  );

  it('M-2: replaces a spoken explanation before TTS on a Scene that shows a quote', () => {
    const scene = slide('m2', [VERSE], ['هذا مثال على النعت. لن نشرح معنى الآية هنا.']);
    expect(codes([scene])).toEqual([SACRED_TEXT_EXPLAINED]);
    expect(stripSacredNarration([scene], quotes)).toBe(1);
    expect((scene.actions as Array<{ text: string }>)[0]!.text).toBe(
      `هذا مثال على النعت. ${SACRED_NARRATION_LINE.quran}.`,
    );
    expect(codes([scene])).toEqual([]);
    // A Scene without a quote keeps its speech.
    const plain = slide('m2b', ['نص'], ['سبب نزول المطر هو التكاثف.']);
    expect(stripSacredNarration([plain], quotes)).toBe(0);
  });

  it('M-4: a verse wrapped across lines still matches its source', () => {
    const words = VERSE.split(' ');
    const wrapped = `${words.slice(0, 3).join(' ')}<br>${words.slice(3).join(' ')}`;
    const scene = slide('m4', [`<p>${wrapped}</p>`]);
    expect(codes([scene])).toEqual([]);
    // Pins stay on the raw text; the shown variant is pinned by its own raw hash.
    const pins = usedSacredQuotePins([scene], quotes);
    expect(pins[0]).toMatchObject({ sha256: VERSE_SHA, used: true });
    expect(pins).toHaveLength(3);
    expect(findPinnedSacredTextEdits([scene], pins)).toEqual([]);
  });

  it('M-6: an exact source hadith in «» without its attribution is an exact span', () => {
    expect(codes([slide('m6', [`من الأمثلة: ${HADITH} المبتدأ: الأعمال`])])).toEqual([]);
    const changed = `«${HADITH_CORE.replace('بالنيات', 'بالنية')}»`;
    expect(codes([slide('m6b', [`من الأمثلة: ${changed}`])])).toEqual([SACRED_TEXT_ALTERED]);
  });

  it('L-1: an explanation in another field of a slide that shows a quote fails', () => {
    expect(codes([{ ...slide('l1', [VERSE]), title: 'تفسير الآية' }])).toEqual([
      SACRED_TEXT_EXPLAINED,
    ]);
    const twoBoxes: SacredSceneLike = {
      id: 'l1b',
      type: 'slide',
      content: {
        type: 'slide',
        canvas: { elements: [{ id: 't', type: 'text', content: VERSE }] },
        assistance: { note: 'سبب نزول هذه الآية معروف' },
      },
      actions: [],
    };
    expect(codes([twoBoxes])).toEqual([SACRED_TEXT_EXPLAINED]);
  });

  it('L-3: checks the content a widget action shows', () => {
    const changed = VERSE.replace('أَنزَلَ', 'أَنزَلْ');
    for (const type of ['widget_annotation', 'widget_reveal', 'widget_highlight']) {
      const scene = {
        id: 'w',
        type: 'interactive',
        content: {},
        actions: [{ id: 'x', type, target: '#a', content: changed }],
      };
      expect(codes([scene]), type).toEqual([SACRED_TEXT_ALTERED]);
    }
  });

  describe('M-1 / M-3: the edit check against recovered quote texts', () => {
    const scenes = [slide('a', [`في قوله تعالى: ${VERSE}`])];
    const pins = usedSacredQuotePins(scenes, quotes);
    const recovered = pinnedQuotesIn(shownSceneTexts(scenes), pins);

    it('refuses an edit that removes the brackets and changes the verse', () => {
      const unbracketed = 'قال تعالى: هو الذي أنزل عليك الكتاب منه آيات محكمات';
      expect(findPinnedSacredTextEdits([slide('a', [unbracketed])], pins)).toEqual([]);
      expect(
        findPinnedSacredTextEdits([slide('a', [unbracketed])], pins, recovered).map((f) => f.code),
      ).toEqual([SACRED_TEXT_ALTERED]);
      expect(
        findPinnedSacredTextEdits(
          [slide('a', ['نص'], ['هو الذي أنزل عليك الكتاب منه آيات'])],
          pins,
          recovered,
        ).map((f) => f.code),
      ).toEqual([SACRED_TEXT_NARRATED]);
    });

    it('accepts a new faithful «…» cut of a recovered quote, and refuses an unfaithful one', () => {
      const cut = '﴿هُوَ الَّذِي أَنزَلَ عَلَيْكَ الْكِتَابَ …﴾';
      expect(findPinnedSacredTextEdits([slide('c', [cut])], pins, recovered)).toEqual([]);
      expect(singleSceneSacredFindings(slide('c', [cut]), pins, recovered)).toEqual([]);
      const bad = '﴿هُوَ … الْكِتَابَ﴾';
      expect(
        findPinnedSacredTextEdits([slide('c', [bad])], pins, recovered).map((f) => f.code),
      ).toEqual([SACRED_TEXT_PINNED]);
    });
  });

  it('H-2: checks generated questions by the quiz rules', () => {
    expect(
      sacredQuestionFindings(
        [{ stem: `أعرب: ${VERSE}`, options: ['نعت', 'بدل'], other: ['الكتاب مفعول به'] }],
        quotes,
      ),
    ).toEqual([]);
    expect(
      sacredQuestionFindings(
        [{ stem: `أعرب: ${VERSE}`, options: ['نعت'], other: ['معنى الآية أن الكتاب نزل'] }],
        quotes,
      ),
    ).toEqual([SACRED_TEXT_EXPLAINED]);
    expect(
      sacredQuestionFindings(
        [{ stem: 'ما نوع التابع؟', options: [VERSE, 'نعت'], other: [] }],
        quotes,
      ),
    ).toEqual([SACRED_TEXT_IN_QUIZ_OPTION]);
    expect(
      sacredQuestionFindings(
        [{ stem: 'أكمل الآية: هو الذي أنزل', options: [], other: [] }],
        quotes,
      ),
    ).toEqual([SACRED_TEXT_COMPLETION_ITEM]);
  });
});

describe('round-2 re-review fixes N-H1, N-M1 to N-M3, N-L2', () => {
  /** A faithful cut of VERSE with an ASCII "...", as a book or a stored Scene may print it. */
  const ASCII_CUT = '﴿هُوَ الَّذِي ... مِنْهُ آيَاتٌ مُّحْكَمَاتٌ﴾';
  /** Closes the source's own gap: «أنزل عليك الكتاب» silently dropped. */
  const GAP_CLOSED = '﴿هُوَ الَّذِي مِنْهُ آيَاتٌ …﴾';
  const cutQuotes = shownQuotesIn([ASCII_CUT]);

  it('N-H1: a cut of a cut never spans the source cut’s own "..." gap', () => {
    expect(cutQuotes).toHaveLength(1);
    // The cut itself, and a further faithful cut of one of its pieces, pass.
    expect(validateSacredText([slide('a', [ASCII_CUT])], cutQuotes)).toEqual([]);
    expect(validateSacredText([slide('b', ['﴿… مِنْهُ آيَاتٌ …﴾'])], cutQuotes)).toEqual([]);
    expect(validateSacredText([slide('c', [GAP_CLOSED])], cutQuotes).map((f) => f.code)).toEqual([
      SACRED_TEXT_ALTERED,
    ]);
  });

  it('N-H1: one-scene regeneration refuses the gap-closing cut', () => {
    const pins = usedSacredQuotePins([slide('a', [ASCII_CUT])], cutQuotes);
    expect(
      singleSceneSacredFindings(slide('r', [GAP_CLOSED]), pins, cutQuotes).map((f) => f.code),
    ).toContain(SACRED_TEXT_PINNED);
  });

  it('N-H1: bank questions refuse the gap-closing cut of a source that prints one', () => {
    const source = detectSacredQuotesByParagraph(`قال تعالى: ${ASCII_CUT}`);
    expect(
      sacredQuestionFindings([{ stem: `أعرب: ${GAP_CLOSED}`, options: [], other: [] }], source),
    ).toEqual([SACRED_TEXT_ALTERED]);
    expect(
      sacredQuestionFindings([{ stem: `أعرب: ${ASCII_CUT}`, options: [], other: [] }], source),
    ).toEqual([]);
  });

  it('N-M1: findings of the added texts only, with "shows a quote" from the book', () => {
    // The book's own stem shows an unbracketed copy (ALTERED on its own) and a verse.
    const book = [`${VERSE} أعرب: هو الذي أنزل عليك الكتاب منه`];
    expect(sacredAddedTextFindings(book, ['الكتاب مفعول به'], quotes)).toEqual([]);
    expect(sacredAddedTextFindings(book, ['كما في ﴿قول مخترع﴾'], quotes)).toEqual([
      SACRED_TEXT_ALTERED,
    ]);
    expect(sacredAddedTextFindings(book, ['معنى الآية أن الكتاب نزل'], quotes)).toEqual([
      SACRED_TEXT_EXPLAINED,
    ]);
  });

  it('N-M2: a stray bracket in one paragraph does not void a verse in another', () => {
    const text = `قال تعالى: ${VERSE}\n\nفي هذه الفقرة قوس شارد ﴾ من التحويل.`;
    expect(detectSacredQuotes({ id: '', normalizedText: text })).toEqual([]);
    expect(detectSacredQuotesByParagraph(text).map((quote) => quote.text)).toEqual([VERSE]);
  });

  it('N-M3: a particle-heavy short quote does not flag ordinary narration', () => {
    const short = detectSacredQuotes({
      id: '',
      normalizedText: 'قال رسول الله ﷺ: «وأنا معه»',
    });
    expect(short).toHaveLength(1);
    const scene = slide('m3', ['قال رسول الله ﷺ: «وأنا معه»'], ['قال الطالب: أنا معه في الرأي.']);
    expect(validateSacredText([scene], short)).toEqual([]);
    // The quote itself is still caught.
    expect(stripSacredSpeech('ثم قال: وأنا معه.', short)).toBe(`${SACRED_NARRATION_LINE.hadith}.`);
    // A normal-spelling quote of five words or more keeps the light fold.
    expect(codes([slide('n', [VERSE], ['هو الذى أنزل عليك الكتاب'])])).toEqual([
      SACRED_TEXT_NARRATED,
    ]);
    expect(codes([slide('n', [VERSE], ['هو الذي انزل علك الكتب منه'])])).toEqual([]);
  });

  it('N-L2: spaces inside brackets and invisible controls compare equal; hashes stay raw', () => {
    const inner = VERSE.slice(1, -1);
    const spaced = `﴿ ${inner.replace('الْكِتَابَ', 'الْكِتَابَ‏')} ﴾`;
    const scene = slide('l2', [spaced]);
    expect(codes([scene])).toEqual([]);
    const pins = usedSacredQuotePins([scene], quotes);
    expect(pins[0]).toMatchObject({ sha256: VERSE_SHA, used: true });
    expect(pins).toHaveLength(3);
    // Extended Quranic marks (U+08D3–U+08FF) never hide a spoken copy.
    expect(codes([slide('l2b', [VERSE], ['هو الذي أنزلࣰ عليك الكتاب منه'])])).toEqual([
      SACRED_TEXT_NARRATED,
    ]);
  });
});

describe('round-3 re-review fixes B-1, H-1, M-1, M-2, L-1 to L-4', () => {
  const verseQuotes = (verse: string) => detectSacredQuotes({ id: '', normalizedText: verse });

  it.each([
    ['﴿ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ﴾', 'الحمد لله رب العالمين'],
    ['﴿مَٰلِكِ يَوْمِ ٱلدِّينِ﴾', 'مالك يوم الدين'],
    // Reverse: a normal-spelling source spoken in mushaf spelling.
    ['﴿الحمد لله رب العالمين﴾', 'ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ'],
    ['﴿مالك يوم الدين﴾', 'مَٰلِكِ يَوْمِ ٱلدِّينِ'],
  ])('B-1: narration never reads the short verse %s (spoken: %s)', (verse, spoken) => {
    const short = verseQuotes(verse);
    expect(short).toHaveLength(1);
    const scene = slide('b1', [verse], [`نقرأ معًا: ${spoken}.`]);
    expect(validateSacredText([scene], short).map((f) => f.code)).toEqual([SACRED_TEXT_NARRATED]);
    expect(stripSacredNarration([scene], short)).toBe(1);
    expect((scene.actions as Array<{ text: string }>)[0]!.text).toBe(
      `${SACRED_NARRATION_LINE.quran}.`,
    );
    expect(validateSacredText([scene], short)).toEqual([]);
  });

  it('H-1: «أكمل الحديث» as a dialogue is not a completion item without a hadith', () => {
    expect(validateSacredText([slide('h1', ['أكمل الحديث بين الصديقين'])], [])).toEqual([]);
    expect(
      sacredQuestionFindings(
        [{ stem: 'أكمل حديثك مع زميلك بجملة اسمية', options: ['أ', 'ب'], other: [] }],
        [],
      ),
    ).toEqual([]);
    // The verse half stays unconditional.
    expect(
      sacredQuestionFindings([{ stem: 'أكمل الآية الكريمة', options: [], other: [] }], []),
    ).toEqual([SACRED_TEXT_COMPLETION_ITEM]);
    // A real hadith completion, with the run's hadith source.
    expect(
      sacredQuestionFindings(
        [{ stem: 'أكمل الحديث الشريف: إنما الأعمال …', options: [], other: [] }],
        quotes,
      ),
    ).toEqual([SACRED_TEXT_COMPLETION_ITEM]);
  });

  it('M-1: a verse split by a blank line is still one quote; a stray bracket stays alone', () => {
    const split = '﴿هُوَ الَّذِي أَنزَلَ\n\nعَلَيْكَ الْكِتَابَ﴾';
    expect(
      detectSacredQuotesByParagraph(`قال تعالى: ${split}\n\nنص آخر`).map((quote) => quote.text),
    ).toEqual([split]);
    expect(
      detectSacredQuotesByParagraph(`قوس شارد ﴾ هنا\n\nقال تعالى: ${VERSE}`).map((q) => q.text),
    ).toEqual([VERSE]);
  });

  it('M-2: attributions with a dagger alef, maddah or wasla are detected', () => {
    for (const attribution of [
      'قَالَ رَسُولُ ٱللَّهِ ﷺ',
      'قَالَ رَسُولُ اللّٰهِ صَلَّىٰ اللّٰهُ عَلَيْهِ وَسَلَّمَ',
      'قَالَ ٱلنَّبِيُّ ﷺ',
    ]) {
      expect(detectSacredText(`${attribution}: «الدين النصيحة»`), attribution).toEqual([
        { kind: 'hadith', text: 'الدين النصيحة' },
      ]);
    }
  });

  it.each([['‥'], ['. . .']])('L-1: a source cut printed with %s keeps its gap', (mark) => {
    const source = shownQuotesIn([`﴿هُوَ الَّذِي ${mark} مِنْهُ آيَاتٌ مُّحْكَمَاتٌ﴾`]);
    expect(source).toHaveLength(1);
    expect(
      validateSacredText([slide('l1', ['﴿هُوَ الَّذِي مِنْهُ آيَاتٌ …﴾'])], source).map(
        (f) => f.code,
      ),
    ).toEqual([SACRED_TEXT_ALTERED]);
  });

  it.each([['‌'], ['‮'], ['⁧']])(
    'L-2: a %j inside a span makes it differ and is never pinned',
    (control) => {
      const changed = VERSE.replace('الْكِتَابَ', `الْ${control}كِتَابَ`);
      const scene = slide('l2', [changed]);
      expect(codes([scene])).toEqual([SACRED_TEXT_ALTERED]);
      const pins = usedSacredQuotePins([scene], quotes);
      expect(pins).toHaveLength(2);
      expect(pins[0]).toMatchObject({ sha256: VERSE_SHA, used: false });
    },
  );

  it('L-4: a spoken verse or hadith introduction is replaced even with no known quote', () => {
    expect(stripSacredSpeech('قال تعالى: إن الله مع الصابرين.', [])).toBe(
      `${SACRED_NARRATION_LINE.quran}.`,
    );
    expect(stripSacredSpeech('لاحظ النعت. يقول الله تعالى في كتابه كذا.', [])).toBe(
      `لاحظ النعت. ${SACRED_NARRATION_LINE.quran}.`,
    );
    expect(stripSacredSpeech('قال رسول الله ﷺ: الدين النصيحة.', [])).toBe(
      `${SACRED_NARRATION_LINE.hadith}.`,
    );
    expect(stripSacredSpeech('قال ﷺ إنما الأعمال بالنيات.', [])).toBe(
      `${SACRED_NARRATION_LINE.hadith}.`,
    );
    expect(validateSacredText([slide('l4', ['نص'], ['قوله تعالى يدل على كذا.'])], [])).toEqual([
      { code: SACRED_TEXT_NARRATED, sceneId: 'l4', message: expect.any(String) },
    ]);
    // Control: an ordinary attribution to a poet is untouched.
    const poet = 'قال الشاعر: ولن يلبث العصران يوم وليلة.';
    expect(stripSacredSpeech(poet, [])).toBe(poet);
  });
});

describe('round-4 re-review fixes MEDIUM-1 to MEDIUM-3, LOW-1, LOW-2', () => {
  it('MEDIUM-1: two lone brackets far apart never make one verse', () => {
    const text = ['قوس ﴿ وحده', 'فقرة', 'فقرة', 'فقرة', 'قوس ﴾ وحده'].join('\n\n');
    expect(detectSacredQuotesByParagraph(text)).toEqual([]);
  });

  it('MEDIUM-1: a stray ﴾, a whole verse, then a stray ﴿ keep the real verse', () => {
    const text = [`قوس شارد ﴾`, `قال تعالى: ${VERSE}`, `قوس شارد ﴿`].join('\n\n');
    expect(detectSacredQuotesByParagraph(text).map((quote) => quote.text)).toEqual([VERSE]);
  });

  it.each([
    ['اكمل الآية'],
    ['أكمل الاية'],
    ['أكمل الآيات'],
    ['أتمم الآية'],
    ['ما تكملة الآية'],
    ['أَكْمِلِ الآيَةَ'],
  ])('MEDIUM-2: «%s» is a completion item', (stem) => {
    expect(sacredQuestionFindings([{ stem, options: [], other: [] }], [])).toEqual([
      SACRED_TEXT_COMPLETION_ITEM,
    ]);
  });

  it('MEDIUM-3: a bare «أكمل الحديث» in a lesson with hadith is a dialogue', () => {
    expect(
      sacredQuestionFindings(
        [{ stem: 'أكمل الحديث بين الصديقين', options: ['أ', 'ب'], other: [] }],
        quotes,
      ),
    ).toEqual([]);
    // Its own hadith words, or a phrase naming the Prophet's hadith, still count.
    expect(
      sacredQuestionFindings(
        [{ stem: 'أكمل الحديث: إنما الأعمال بالنيات …', options: [], other: [] }],
        quotes,
      ),
    ).toEqual([SACRED_TEXT_COMPLETION_ITEM]);
    expect(
      sacredQuestionFindings([{ stem: 'اكمل حديث النبي ﷺ', options: [], other: [] }], []),
    ).toEqual([SACRED_TEXT_COMPLETION_ITEM]);
  });

  it('LOW-1: an introduction with nothing after it also replaces the next sentence', () => {
    // Both lines become the owner's line (collapsed into one); the verse is gone.
    const stripped = stripSacredSpeech('لاحظ. قال تعالى:\nإن الله مع الصابرين.\nثم نعرب.', []);
    expect(stripped).toBe(`لاحظ. ${SACRED_NARRATION_LINE.quran}.\nثم نعرب.`);
    expect(stripped).not.toContain('الصابرين');
  });

  it.each([
    ['قال الله عز وجل: إن الله مع الصابرين.', 'quran'],
    ['قال سبحانه: إن الله مع الصابرين.', 'quran'],
    ['قال الله تبارك وتعالى: إن الله مع الصابرين.', 'quran'],
    ['يقول الحق سبحانه وتعالى: إن الله مع الصابرين.', 'quran'],
    ['قـال تعـالى: إن الله مع الصابرين.', 'quran'],
    ['قال تعالي: إن الله مع الصابرين.', 'quran'],
    ['قال رسول الله: «الدين النصيحة».', 'hadith'],
  ] as const)('LOW-2: «%s» is replaced', (spoken, kind) => {
    expect(stripSacredSpeech(spoken, [])).toBe(`${SACRED_NARRATION_LINE[kind]}.`);
  });

  it.each([
    ['قال الله: إن الله مع الصابرين.'],
    ['يقول الله في كتابه: إن الله مع الصابرين.'],
    ['قال ربنا: إن الله مع الصابرين.'],
  ])('round 5 HIGH: «%s» is replaced', (spoken) => {
    expect(stripSacredSpeech(spoken, [])).toBe(`${SACRED_NARRATION_LINE.quran}.`);
  });

  it('round 5 HIGH control: «قال الله في هذا الدرس» with no colon is unchanged', () => {
    const spoken = 'قال الله في هذا الدرس كلامًا نعربه.';
    expect(stripSacredSpeech(spoken, [])).toBe(spoken);
  });

  it('round 5 M-1: an intro carries over a verse of two sentences, to the end of its line', () => {
    const stripped = stripSacredSpeech(
      'قال تعالى: إن الله مع الصابرين. واصبروا إن الله معكم.\nثم نعرب الجملة.',
      [],
    );
    expect(stripped).toBe(`${SACRED_NARRATION_LINE.quran}.\nثم نعرب الجملة.`);
    expect(stripped).not.toContain('واصبروا');
    const nextLine = stripSacredSpeech(
      'قال تعالى:\nإن الله مع الصابرين. واصبروا إن الله معكم.\nثم نعرب الجملة.',
      [],
    );
    expect(nextLine).toBe(`${SACRED_NARRATION_LINE.quran}.\nثم نعرب الجملة.`);
  });

  it.each([['أكملوا الآية'], ['أتمموا الآية'], ['أكمل قوله تعالى: إن الله …']])(
    'round 5 M-2: «%s» is a completion item',
    (stem) => {
      expect(sacredQuestionFindings([{ stem, options: [], other: [] }], [])).toEqual([
        SACRED_TEXT_COMPLETION_ITEM,
      ]);
    },
  );

  it('round 6 H-1: an unclosed ﴿ carries to the closing bracket or the end of the line', () => {
    const open = stripSacredSpeech(
      'قال تعالى ﴿ وأقيموا الصلاة. وآتوا الزكاة. واركعوا مع الراكعين\nثم نعرب.',
      [],
    );
    expect(open).toBe(`${SACRED_NARRATION_LINE.quran}\nثم نعرب.`);
    expect(open).not.toContain('الزكاة');
    const closed = stripSacredSpeech(
      'قال تعالى ﴿ وأقيموا الصلاة. وآتوا الزكاة ﴾. لنحدد الفعل.',
      [],
    );
    expect(closed).toBe(`${SACRED_NARRATION_LINE.quran}. لنحدد الفعل.`);
  });

  it.each([
    ['قال الله في سورة البقرة: إن الله مع الصابرين.'],
    ['قال ربنا عز وجل: إن الله مع الصابرين.'],
    ['يقول ربنا سبحانه: إن الله مع الصابرين.'],
    ['يقول الله في محكم التنزيل: إن الله مع الصابرين.'],
    ['قال ربكم: إن الله مع الصابرين.'],
  ])('round 6 H-2: «%s» is replaced', (spoken) => {
    expect(stripSacredSpeech(spoken, [])).toBe(`${SACRED_NARRATION_LINE.quran}.`);
  });

  it.each([['أكمل قول الله تعالى: إن الله …'], ['أكمل قوله سبحانه: إن الله …']])(
    'round 6 M-4: «%s» is a completion item',
    (stem) => {
      expect(sacredQuestionFindings([{ stem, options: [], other: [] }], [])).toEqual([
        SACRED_TEXT_COMPLETION_ITEM,
      ]);
    },
  );

  it('LOW-2 controls: a poet, a writer, and «قال رسول الله» with no colon or quote', () => {
    for (const spoken of [
      'قال الشاعر: ولن يلبث العصران.',
      'يقول الكاتب: إن القراءة مفيدة.',
      'قال رسول الله في هذا الدرس كلامًا نعربه.',
    ]) {
      expect(stripSacredSpeech(spoken, []), spoken).toBe(spoken);
    }
  });
});

describe('exercise and check items: no verse or hadith (owner, 4 Nov 2026)', () => {
  const VERSE_2 = '﴿قُلْ هُوَ اللَّهُ أَحَدٌ﴾';
  const POEMS = [
    '1. وما المرء إلا كالشهاب وضوئه',
    '2. إذا المرء لم يدنس من اللؤم عرضه',
    '3. ألا كل شيء ما خلا الله باطل',
  ];
  const UNIT = [
    'عيّن التابع والمتبوع فيما يأتي:',
    POEMS[0],
    `4. ${VERSE}`,
    POEMS[1],
    `5. ${VERSE_2}`,
    POEMS[2],
  ].join('\n');

  it('keeps the 3 poetry items of the unit and drops the 2 verse items', () => {
    expect(withoutSacredItems(UNIT).split('\n')).toEqual([
      'عيّن التابع والمتبوع فيما يأتي:',
      ...POEMS,
    ]);
    // A hadith item is dropped the same way.
    expect(withoutSacredItems(`قال رسول الله ﷺ: ${HADITH}\n${POEMS[0]}`)).toBe(POEMS[0]);
  });

  it('flags and strips verse items on an exercise slide, shown and spoken', () => {
    const items = [POEMS[0], VERSE, POEMS[1], VERSE_2, POEMS[2]];
    const scene = slide(
      'ex',
      [['<p>عيّن التابع:</p>', ...items.map((line) => `<p>${line}</p>`)].join('')],
      [`نبدأ بالبيت الأول. ${VERSE}. ثم البيت الثاني.`],
    );
    (scene.content as Record<string, unknown>).contentRole = 'practice';
    const scope = { exerciseSceneIds: new Set<string>() };
    expect(validateSacredText([scene], quotes, scope).map((f) => f.code)).toContain(
      SACRED_TEXT_IN_EXERCISE,
    );
    expect(stripSacredExerciseItems([scene], quotes, scope)).toBe(1);
    expect(validateSacredText([scene], quotes, scope)).toEqual([]);
    const shown = shownSceneTexts([scene]).join('\n');
    for (const poem of POEMS) expect(shown).toContain(poem);
    expect(shown).not.toMatch(/[﴾﴿]/);
    expect((scene.actions as Array<{ text: string }>)[0]!.text).toBe(
      'نبدأ بالبيت الأول. ثم البيت الثاني.',
    );
  });

  it('L-6: never leaves an empty speech after the strip', () => {
    const scope = { exerciseSceneIds: new Set(['ex', 'only']) };
    // A speech that read only the verse is dropped; the other narration stays.
    const scene = slide('ex', [`<p>${POEMS[0]}</p>`], [`قال تعالى: ${VERSE}`, 'نحل البيت.']);
    expect(stripSacredExerciseItems([scene], quotes, scope)).toBe(1);
    expect((scene.actions as Array<{ text: string }>).map((action) => action.text)).toEqual([
      'نحل البيت.',
    ]);
    // The Scene's only narration becomes a line, never ''.
    const only = slide('only', [`<p>${POEMS[0]}</p>`], [`${VERSE}`]);
    stripSacredExerciseItems([only], quotes, scope);
    expect((only.actions as Array<{ text: string }>).map((action) => action.text)).toEqual([
      EXERCISE_NEUTRAL_LINE,
    ]);
  });

  it('E-10: a «تأكد» try-it slide gets a try-it prompt line, never the solving line', () => {
    const scope = { exerciseSceneIds: new Set(['try']) };
    const tryIt = slide('try', [`<p>${POEMS[0]}</p><p>${VERSE}</p>`], [`قال تعالى: ${VERSE}`]);
    (tryIt.content as Record<string, unknown>).contentRole = 'check_understanding';
    stripSacredExerciseItems([tryIt], quotes, scope);
    expect((tryIt.actions as Array<{ text: string }>).map((action) => action.text)).toEqual([
      TRY_IT_NEUTRAL_LINE,
    ]);
    expect(TRY_IT_NEUTRAL_LINE).not.toBe(EXERCISE_NEUTRAL_LINE);
  });

  it('F-5: a neutral line once the verse left the display; the owner line while one is shown', () => {
    const scope = { exerciseSceneIds: new Set(['gone', 'shown']) };
    // The verse item was removed from the display: never «تأمّل الآية المعروضة».
    const gone = slide('gone', [`<p>${POEMS[0]}</p><p>${VERSE}</p>`], [`قال تعالى: ${VERSE}`]);
    stripSacredExerciseItems([gone], quotes, scope);
    const goneSpoken = (gone.actions as Array<{ text: string }>).map((action) => action.text);
    expect(goneSpoken).toEqual([EXERCISE_NEUTRAL_LINE]);
    expect(goneSpoken.join(' ')).not.toContain(SACRED_NARRATION_LINE.quran);
    expect(shownSceneTexts([gone]).join('\n')).not.toMatch(/[﴾﴿]/);
    // A quote the strip leaves on the display keeps the owner's line.
    const shown = slide(
      'shown',
      [`<p>${POEMS[0]}</p><p>${HADITH}</p>`],
      [`قال رسول الله ﷺ: ${HADITH}`],
    );
    stripSacredExerciseItems([shown], quotes, scope);
    expect((shown.actions as Array<{ text: string }>).map((action) => action.text)).toEqual([
      SACRED_NARRATION_LINE.hadith,
    ]);
  });

  it('marks a scene by its outline citing an exercise unit', () => {
    const ids = exerciseSceneIdsOf(
      [
        { id: 's1', outlineId: 'o1' },
        { id: 's2', outlineId: 'o2' },
      ],
      [
        { id: 'o1', sourceContentUnitIds: ['u-ex'] },
        { id: 'o2', sourceContentUnitIds: ['u-explain'] },
      ],
      new Set(['u-ex']),
    );
    expect([...ids]).toEqual(['s1']);
    const scene = slide('s1', [`<p>${VERSE}</p><p>${POEMS[0]}</p>`]);
    expect(
      validateSacredText([scene], quotes, { exerciseSceneIds: ids }).map((f) => f.code),
    ).toEqual([SACRED_TEXT_IN_EXERCISE]);
  });

  it('leaves a verse on an explanation slide untouched', () => {
    const scene = slide('exp', [`<p>قال تعالى: ${VERSE}</p>`]);
    (scene.content as Record<string, unknown>).contentRole = 'explanation';
    const before = JSON.stringify(scene);
    const scope = { exerciseSceneIds: new Set<string>() };
    expect(stripSacredExerciseItems([scene], quotes, scope)).toBe(0);
    expect(JSON.stringify(scene)).toBe(before);
    expect(validateSacredText([scene], quotes, scope)).toEqual([]);
    // Without a scope (g5.v7 and earlier) the rule is off.
    const practice = slide('p', [`<p>${VERSE}</p>`]);
    (practice.content as Record<string, unknown>).contentRole = 'practice';
    expect(validateSacredText([practice], quotes).map((f) => f.code)).not.toContain(
      SACRED_TEXT_IN_EXERCISE,
    );
  });
});

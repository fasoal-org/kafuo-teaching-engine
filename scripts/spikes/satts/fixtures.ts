/**
 * SATTS Wave 0 spike fixtures (not shipped).
 * Plan: docs/frds/subject-aware-scientific-tts-implementation-plan.md v0.2 — §12.1, §10.1, §10.3, §19 Wave 0.
 *
 * All sentences are *prepared* text: what the renderer would emit, not raw notation.
 * Integers stay as digits except in structural roles (plan §10.1 Numbers); chemistry uses
 * D-9 letter names + D-9a English counts in Arabic script + Arabic MSA coefficients.
 */

/** Draft delivery instructions `ar-SA-saudi-edu-v1` (plan §12.1). English, <600 chars, no digits, no Arabic, no LaTeX. */
export const SAUDI_INSTRUCTIONS_V1 =
  'Read the Arabic text aloud exactly as written, with a natural Saudi Arabic accent. ' +
  'Keep the educational Modern Standard wording; never rewrite it into colloquial dialect. ' +
  'Do not add, omit, translate, paraphrase or explain anything. ' +
  'Pronounce numbers, units and terms clearly and deliberately. ' +
  'Pause briefly at every comma, and before and after any relation between quantities. ' +
  "Speak at a calm, warm teacher's pace, and keep the same voice character across consecutive parts.";

// Guard the semantic-free rule the plan will later enforce as a unit test.
if (SAUDI_INSTRUCTIONS_V1.length >= 600) throw new Error('instructions ≥ 600 chars');
if (/[0-9٠-٩]/.test(SAUDI_INSTRUCTIONS_V1)) throw new Error('instructions contain digits');
if (/[؀-ۿ]/.test(SAUDI_INSTRUCTIONS_V1)) throw new Error('instructions contain Arabic');
if (/\\/.test(SAUDI_INSTRUCTIONS_V1)) throw new Error('instructions contain LaTeX');

export type ScreeningCategory =
  | 'prose'
  | 'math'
  | 'physics'
  | 'chemistry'
  | 'negdec-percent'
  | 'mixed-long';

export interface ScreeningSentence {
  nn: string;
  category: ScreeningCategory;
  text: string;
}

/** Exactly 10 short MSA sentences (D-2). */
export const SCREENING_SENTENCES: ScreeningSentence[] = [
  {
    nn: '01',
    category: 'prose',
    text: 'في هذا الدرس سنتعرف على ثلاث أفكار رئيسية، ثم نحل 12 تمرينًا معًا.',
  },
  { nn: '02', category: 'prose', text: 'يتكون الفصل من 25 طالبًا، وقد حضر منهم اليوم 23 طالبًا.' },
  { nn: '03', category: 'math', text: '3 على 4 زائد س تربيع، أكبر من أو يساوي، 5.' },
  {
    nn: '04',
    category: 'math',
    text: 'الجذر التربيعي لـ 16 يساوي 4، والجذر التكعيبي لـ 27 يساوي 3.',
  },
  {
    nn: '05',
    category: 'physics',
    text: 'تسقط الأجسام قرب سطح الأرض بتسارع مقداره تسعة فاصلة ثمانية متر لكل ثانية تربيع.',
  },
  {
    nn: '06',
    category: 'physics',
    text: 'أثّرت قوة مقدارها خمسة نيوتن على الجسم، فتحرك مسافة عشرين مترًا.',
  },
  {
    nn: '07',
    category: 'chemistry',
    text: 'يتكون جزيء الماء، إتش تو أو، من ذرتي هيدروجين وذرة أكسجين واحدة.',
  },
  {
    nn: '08',
    category: 'chemistry',
    text: 'في هذا التفاعل: اثنان إتش تو زائد أو تو ينتج اثنان إتش تو أو.',
  },
  {
    nn: '09',
    category: 'negdec-percent',
    text: 'انخفضت درجة الحرارة إلى سالب 3 فاصلة 5 درجة مئوية، وارتفعت الرطوبة بنسبة 40 بالمئة.',
  },
  {
    nn: '10',
    category: 'mixed-long',
    text:
      'في تجربة اليوم، سقط جسم كتلته 2 كيلوغرام بتسارع تسعة فاصلة ثمانية متر لكل ثانية تربيع، ' +
      'ثم وجدنا أن 3 على 4 من المسافة، أكبر من أو يساوي، سالب 1 فاصلة 5، ' +
      'وفي الجزء الأخير تكوّن الماء، إتش تو أو، بنسبة 60 بالمئة من الناتج.',
  },
];
if (SCREENING_SENTENCES.length !== 10) throw new Error('need exactly 10 screening sentences');

export type DigitScript = 'western' | 'arabic-indic';
export type IntegerRange = '0-20' | 'tens' | 'hundreds' | 'thousands';
export type NounGender = 'masculine' | 'feminine' | 'none';

export interface IntegerProbeItem {
  id: string;
  range: IntegerRange;
  gender: NounGender;
  script: DigitScript;
  n: number;
  /** Final text with the integer written in `script` digits. */
  text: string;
  /**
   * Expected spoken form (pausal, MSA). AUTHOR'S REFERENCE — the human reviewer may correct it,
   * especially gender agreement (3–10 reversed, 11–19 compounds) and case.
   */
  expected: string;
}

const toArabicIndic = (s: string) =>
  s.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));

// [range, gender, script, n, template with {n}, expected]
const RAW_PROBE: [IntegerRange, NounGender, DigitScript, number, string, string][] = [
  ['0-20', 'none', 'western', 0, 'درجة الحرارة الآن {n} درجة.', 'صفر'],
  ['0-20', 'none', 'western', 1, 'افتح الكتاب على الصفحة {n}.', 'واحد'],
  ['0-20', 'none', 'arabic-indic', 2, 'اكتب العدد {n} على السبورة.', 'اثنان'],
  ['0-20', 'masculine', 'western', 3, 'في الصف {n} طلاب جدد.', 'ثلاثة طلاب'],
  ['0-20', 'feminine', 'arabic-indic', 3, 'في الحقيبة {n} كراسات.', 'ثلاث كراسات'],
  ['0-20', 'masculine', 'western', 4, 'قرأت هذا الشهر {n} كتب.', 'أربعة كتب'],
  ['0-20', 'feminine', 'arabic-indic', 5, 'حلّت الطالبة {n} مسائل.', 'خمس مسائل'],
  ['0-20', 'masculine', 'western', 6, 'في العلبة {n} أقلام.', 'ستة أقلام'],
  ['0-20', 'feminine', 'arabic-indic', 7, 'مرّت {n} سنوات على افتتاح المدرسة.', 'سبع سنوات'],
  ['0-20', 'masculine', 'western', 8, 'يوجد {n} رجال في القاعة.', 'ثمانية رجال'],
  ['0-20', 'feminine', 'arabic-indic', 8, 'استغرقت الرحلة {n} ساعات.', 'ثماني ساعات'],
  ['0-20', 'masculine', 'arabic-indic', 9, 'شارك في المسابقة {n} معلمين.', 'تسعة معلمين'],
  ['0-20', 'feminine', 'western', 10, 'في الفقرة {n} جمل.', 'عشر جمل'],
  ['0-20', 'masculine', 'western', 11, 'حضر الدرس {n} طالبًا.', 'أحد عشر طالبًا'],
  ['0-20', 'feminine', 'arabic-indic', 11, 'حضرت الدرس {n} طالبة.', 'إحدى عشرة طالبة'],
  ['0-20', 'masculine', 'western', 12, 'في الفريق {n} لاعبًا.', 'اثنا عشر لاعبًا'],
  ['0-20', 'feminine', 'arabic-indic', 12, 'في الشعبة {n} طالبة.', 'اثنتا عشرة طالبة'],
  ['0-20', 'masculine', 'western', 13, 'أجاب عن السؤال {n} طالبًا.', 'ثلاثة عشر طالبًا'],
  ['0-20', 'feminine', 'arabic-indic', 15, 'أجابت عن السؤال {n} طالبة.', 'خمس عشرة طالبة'],
  ['0-20', 'feminine', 'western', 17, 'استمر العرض {n} دقيقة.', 'سبع عشرة دقيقة'],
  ['0-20', 'masculine', 'arabic-indic', 19, 'في الصندوق {n} كتابًا.', 'تسعة عشر كتابًا'],
  ['0-20', 'masculine', 'western', 20, 'عمر أخي {n} عامًا.', 'عشرون عامًا'],
  ['tens', 'masculine', 'western', 30, 'في المدرسة {n} معلمًا.', 'ثلاثون معلمًا'],
  ['tens', 'feminine', 'arabic-indic', 40, 'في المكتبة {n} طاولة.', 'أربعون طاولة'],
  ['tens', 'masculine', 'western', 50, 'المسافة بين المدينتين {n} كيلومترًا.', 'خمسون كيلومترًا'],
  ['tens', 'feminine', 'arabic-indic', 60, 'في الحديقة {n} شجرة.', 'ستون شجرة'],
  ['tens', 'masculine', 'western', 70, 'حضر المعرض {n} زائرًا.', 'سبعون زائرًا'],
  ['tens', 'masculine', 'arabic-indic', 90, 'في القاعة {n} مقعدًا.', 'تسعون مقعدًا'],
  ['tens', 'masculine', 'western', 21, 'في الفصل {n} طالبًا.', 'واحد وعشرون طالبًا'],
  ['tens', 'feminine', 'arabic-indic', 21, 'في الفصل {n} طالبة.', 'إحدى وعشرون طالبة'],
  ['tens', 'feminine', 'western', 35, 'في الكتاب {n} صفحة.', 'خمس وثلاثون صفحة'],
  ['tens', 'masculine', 'arabic-indic', 48, 'في المنهج {n} درسًا.', 'ثمانية وأربعون درسًا'],
  ['tens', 'feminine', 'western', 99, 'في الحقل {n} نخلة.', 'تسع وتسعون نخلة'],
  ['hundreds', 'masculine', 'western', 100, 'في المدرسة {n} طالب.', 'مئة طالب'],
  ['hundreds', 'masculine', 'arabic-indic', 200, 'في المدرسة {n} طالب.', 'مئتا طالب'],
  ['hundreds', 'masculine', 'western', 300, 'طُبع من المجلة {n} عدد.', 'ثلاثمئة عدد'],
  ['hundreds', 'masculine', 'arabic-indic', 500, 'في الملعب {n} مشجع.', 'خمسمئة مشجع'],
  ['hundreds', 'feminine', 'western', 125, 'في المكتبة {n} مجلة.', 'مئة وخمس وعشرون مجلة'],
  [
    'hundreds',
    'masculine',
    'arabic-indic',
    243,
    'في المكتبة {n} كتابًا.',
    'مئتان وثلاثة وأربعون كتابًا',
  ],
  [
    'hundreds',
    'masculine',
    'western',
    999,
    'سجّل في البرنامج {n} مشاركًا.',
    'تسعمئة وتسعة وتسعون مشاركًا',
  ],
  [
    'hundreds',
    'masculine',
    'arabic-indic',
    150,
    'طول الطاولة {n} سنتيمترًا.',
    'مئة وخمسون سنتيمترًا',
  ],
  ['thousands', 'masculine', 'western', 1000, 'في الحي {n} منزل.', 'ألف منزل'],
  ['thousands', 'masculine', 'arabic-indic', 2000, 'في الحي {n} منزل.', 'ألفا منزل'],
  ['thousands', 'masculine', 'western', 3000, 'حضر المؤتمر {n} شخص.', 'ثلاثة آلاف شخص'],
  ['thousands', 'feminine', 'arabic-indic', 10000, 'بيعت من الكتاب {n} نسخة.', 'عشرة آلاف نسخة'],
  ['thousands', 'feminine', 'western', 1250, 'عدد سكان القرية {n} نسمة.', 'ألف ومئتان وخمسون نسمة'],
  [
    'thousands',
    'feminine',
    'arabic-indic',
    4321,
    'في الأرشيف {n} وثيقة.',
    'أربعة آلاف وثلاثمئة وإحدى وعشرون وثيقة',
  ],
  [
    'thousands',
    'none',
    'western',
    1448,
    'السنة الهجرية الحالية هي {n}.',
    'ألف وأربعمئة وثمانية وأربعون',
  ],
  ['thousands', 'masculine', 'arabic-indic', 15000, 'طول المضمار {n} متر.', 'خمسة عشر ألف متر'],
  ['thousands', 'none', 'western', 100000, 'العدد {n} عدد كبير.', 'مئة ألف'],
];

export const INTEGER_PROBE: IntegerProbeItem[] = RAW_PROBE.map(
  ([range, gender, script, n, tpl, expected], i) => {
    const digits = script === 'arabic-indic' ? toArabicIndic(String(n)) : String(n);
    return {
      id: String(i + 1).padStart(2, '0'),
      range,
      gender,
      script,
      n,
      text: tpl.replace('{n}', digits),
      expected,
    };
  },
);
if (INTEGER_PROBE.length !== 50) throw new Error('need exactly 50 integer probe items');

export interface ChemistryItem {
  id: string;
  formula: string;
  /** English numerals present (D-9a), for review grouping. */
  englishCounts: string[];
  text: string;
}

/**
 * 12 D-9/D-9a sentences. Letter and numeral spellings are PROVISIONAL placeholders
 * until `chem-letters.json` is approved.
 */
export const CHEMISTRY_SENTENCES: ChemistryItem[] = [
  {
    id: '01',
    formula: 'H₂O',
    englishCounts: ['two'],
    text: 'الماء، إتش تو أو، سائل عند درجة حرارة الغرفة.',
  },
  {
    id: '02',
    formula: 'CO₂',
    englishCounts: ['two'],
    text: 'يطلق الإنسان في الزفير غاز سي أو تو.',
  },
  {
    id: '03',
    formula: 'H₂SO₄',
    englishCounts: ['two', 'four'],
    text: 'حمض الكبريتيك صيغته إتش تو إس أو فور.',
  },
  { id: '04', formula: 'NaCl', englishCounts: [], text: 'ملح الطعام صيغته إن إيه سي إل.' },
  {
    id: '05',
    formula: 'Ca(OH)₂',
    englishCounts: ['two'],
    text: 'صيغة هيدروكسيد الكالسيوم هي سي إيه (أو إتش) تو.',
  },
  {
    id: '06',
    formula: '2H₂ + O₂ → 2H₂O',
    englishCounts: ['two'],
    text: 'اثنان إتش تو زائد أو تو ينتج اثنان إتش تو أو.',
  },
  {
    id: '07',
    formula: 'CH₄ + 2O₂ → CO₂ + 2H₂O',
    englishCounts: ['four', 'two'],
    text: 'سي إتش فور زائد اثنان أو تو ينتج سي أو تو زائد اثنان إتش تو أو.',
  },
  {
    id: '08',
    formula: 'NH₃',
    englishCounts: ['three'],
    text: 'للأمونيا، إن إتش ثري، رائحة نفاذة.',
  },
  {
    id: '09',
    formula: 'C₃H₈',
    englishCounts: ['three', 'eight'],
    text: 'غاز البروبان صيغته سي ثري إتش إيت.',
  },
  {
    id: '10',
    formula: 'C₂H₅OH',
    englishCounts: ['two', 'five'],
    text: 'الإيثانول صيغته سي تو إتش فايف أو إتش.',
  },
  {
    id: '11',
    formula: 'P₄O₁₀',
    englishCounts: ['four', 'ten'],
    text: 'صيغة هذا الأكسيد هي بي فور أو تِن.',
  },
  {
    id: '12',
    formula: 'C₆H₁₂O₆',
    englishCounts: ['six', 'twelve'],
    text: 'الجلوكوز صيغته سي سِكس إتش تْوِلف أو سِكس.',
  },
];
if (CHEMISTRY_SENTENCES.length !== 12) throw new Error('need exactly 12 chemistry sentences');

export const ALL_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
] as const;

export const PINNED_MODEL = 'gpt-4o-mini-tts-2025-12-15';

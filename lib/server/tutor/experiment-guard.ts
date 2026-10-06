/**
 * P0 Student Experiment Safety Guard (Kafuo R1 FRD SAFE-01/02; plan §8.4).
 *
 * Deterministic and model-independent: a bilingual hazard lexicon over the
 * NORMALISED student message (pre-check) and pattern rules over the finished
 * model output (post-check). It applies to Free Chat, Help and Simplify-style
 * turns on BOTH routes of the subject pair, including the legacy help-turn
 * endpoint — the model is never the last line of defence.
 *
 *  - `preCheck`: detect risk → `{ triggered, categories, directive }`. The
 *    directive is added to the prompt (preserve the learning goal, refuse
 *    operational steps, offer a safer alternative) and `safety.triggered` is
 *    recorded on the turn.
 *  - `postCheck`: operational hazard instructions in the reply — quantities
 *    next to hazardous reagents, or a step sequence with ignition / mixing /
 *    heating verbs — replace the whole reply with the fixed boundary message
 *    (`SAFETY_BOUNDARY`). The ledger keeps the model's own outcome.
 *  - `guardOrBoundary`: any exception inside a guard yields the boundary
 *    (SAFE-02 — a guard that cannot assess never lets a confident hazardous
 *    answer through).
 *
 * Pure functions; nothing here logs student text.
 */
import { normalizeArabic, normalizeText } from '@/lib/server/tutor/arabic-text';
import { SAFETY_DIRECTIVE_TEXT } from '@/lib/server/tutor/tutor-rules';

export type HazardCategory =
  | 'heights'
  | 'fire_heating'
  | 'electricity'
  | 'chemicals_fumes_mixing'
  | 'sharp_tools'
  | 'glassware'
  | 'ingestion'
  | 'skin_eye_contact'
  | 'supervision';

export const HAZARD_CATEGORIES: readonly HazardCategory[] = [
  'heights',
  'fire_heating',
  'electricity',
  'chemicals_fumes_mixing',
  'sharp_tools',
  'glassware',
  'ingestion',
  'skin_eye_contact',
  'supervision',
];

type Matcher = RegExp | ((normalized: string) => boolean);

/** Unicode-aware word edges: `\b` is ASCII-only and useless for Arabic. */
const EDGE_L = '(?<![\\p{L}\\p{N}])';
const EDGE_R = '(?![\\p{L}\\p{N}])';
function words(alternatives: string): RegExp {
  return new RegExp(`${EDGE_L}(?:${alternatives})${EDGE_R}`, 'iu');
}

/** Both patterns must appear somewhere in the (whitespace-collapsed) message. */
function both(a: RegExp, b: RegExp): Matcher {
  return (text) => a.test(text) && b.test(text);
}

/** Hands-on verbs: a reagent or tool NAMED in a theory question is not a hazard; one ACTED on is. */
const ACTION_EN = words(
  'mix|mixing|mixed|pour|pouring|add|adding|heat|heating|boil|boiling|make|making|prepare|try|trying|test|testing|do|doing|use|using|combine|dissolve|burn|burning|touch|touching|hold|spray|apply|put|drop|throw|cut|cutting|open|opening|stab|pierce|poke|lick|taste|drink|eat|swallow',
);
const ACTION_AR = new RegExp(
  '(اخلط|نخلط|هخلط|خلط|اصب|صب|نصب|اضيف|اضف|نضيف|هضيف|اسخن|سخن|نسخن|هسخن|تسخين|اغلي|نغلي|اعمل|نعمل|هعمل|اجرب|نجرب|هجرب|احضر|نحضر|استخدم|نستخدم|اذيب|احرق|نحرق|هحرق|المس|امسك|ارش|احط|نحط|هحط|ارمي|نرمي|هرمي|اقطع|نقطع|هقطع|افتح|اطعن|اثقب|اتذوق|اذوق|نذوق|اشرب|نشرب|اكل|ناكل|ابلع|الحس|اشعل|نشعل|هشعل)',
  'u',
);

/**
 * Lexicon per category, matched against `normalizeText(message)` (Arabic
 * tashkeel stripped, alef/taa marbuta/yaa unified, lower-case Latin,
 * whitespace collapsed). Arabic entries are therefore written in their
 * normalised form (ه for ة, ي for ى, ا for أ/إ/آ). Bare mentions of
 * classroom nouns (acid, flame, test tube, current, knife) do NOT trigger on
 * their own — a theory question about acids is not an experiment — but any
 * of them combined with a hands-on verb does.
 */
const LEXICON: Readonly<Record<HazardCategory, readonly Matcher[]>> = {
  heights: [
    words('from the roof|off the (roof|balcony|ledge)|from a height|from up high|rooftop|out of the window|from the window|from the balcony|(climb|climbing|jump|jumping) (onto|on|off|from|out of) (the )?(roof|balcony|window|ladder|top|railing|tree)'),
    /(من (السطح|البلكونه|الشرفه|الشباك|فوق|مكان عالي|السلم|الشجره)|من ارتفاع|سطح البيت|سلم عالي|اقفز من|نقفز من|اتسلق (السطح|الشباك|السور|الشجره))/u,
  ],
  fire_heating: [
    words('set (it |them |this )?on fire|light (it|this|them|a fire|a match|the lighter|the alcohol|the paper|the gas)|lighter|matches|ignite|igniting|ignition|blowtorch|bonfire|gasoline|petrol|kerosene|fireworks?|explosive|explosives|burn (it|this|them|some|the|at home|myself|paper|plastic)|heat (it|this|them|the \\w+) (up )?(on|over|with) (the |a )?(stove|flame|fire|burner|lighter|candle)|boil(ing)? (oil|gasoline|petrol|alcohol|acetone)'),
    /(اشعل|نشعل|هشعل|اشعال|احرق|نحرق|هحرق|ولاعه|كبريت|بنزين|جاز|كيروسين|العاب ناريه|متفجر|تفجير|(اسخن|سخن|نسخن|هسخن)(ه|ها|هم)? (علي|فوق) (النار|البوتاجاز|الموقد|الشمعه|الولاعه)|(اغلي|نغلي) (زيت|بنزين|كحول|اسيتون))/u,
  ],
  electricity: [
    words('electric(al)? shock|wall socket|power (socket|outlet)|outlet|mains|bare wires?|live wire|high voltage|car battery|short[- ]circuit|electrocut(e|ed|ion)|touch(ing)? the wires?|strip the wires?'),
    both(words('stick|put|insert|push|poke'), words('socket|outlet|plug')),
    /(صدمه كهربائيه|فيشه|الفيشه|بريزه|البريزه|سلك مكشوف|اسلاك مكشوفه|سلك عاري|جهد عالي|بطاريه (السياره|العربيه)|قصر كهربائي|ماس كهربائي|(المس|امسك|هلمس) (السلك|الاسلاك|الكهرباء)|(احط|هحط|ادخل) .{0,25}(في|جوه) (الفيشه|البريزه))/u,
  ],
  chemicals_fumes_mixing: [
    words('bleach|ammonia|chlorine|thermite|mercury|drain cleaner|toxic gas|poison(ous)? gas|fumes|potassium (nitrate|permanganate|chlorate)|sodium metal|lye|caustic soda'),
    both(ACTION_EN, words('acid|acids|hydrochloric|sulfuric|sulphuric|nitric|sodium hydroxide|hydrogen peroxide|acetone|alcohol|ethanol|methanol|pesticide|insecticide|chemicals?|cleaners?|detergents?|magnesium')),
    /(كلور|الكلور|امونيا|نشادر|ثرمايت|زئبق|غاز سام|ابخره سامه|بخار سام|صودا كاويه|برمنجنات|كلورات البوتاسيوم|نترات البوتاسيوم|صوديوم معدني)/u,
    both(ACTION_AR, /(حمض|احماض|حامض|هيدروكلوريك|كبريتيك|نيتريك|هيدروكسيد|ماء اكسجين|بيروكسيد|اسيتون|كحول|ايثانول|ميثانول|مبيد|كيماويات|مواد كيميائيه|ماده كيميائيه|منظف|منظفات|ماغنسيوم|مغنيسيوم)/u),
    /(اخلط|نخلط|هخلط|خلط|امزج|نمزج) (الكلور|الامونيا|المنظفات|منظفات|الحمض|حمض|المواد الكيميائيه|مواد كيميائيه|كيماويات)/u,
  ],
  sharp_tools: [
    both(ACTION_EN, words('knife|knives|blade|razor|scalpel|box cutter|cutter|saw|axe|hatchet|needle|syringe|drill|nail gun')),
    words('cut (myself|my (hand|finger|skin|arm)|the skin|open (it|the battery|a battery))'),
    both(ACTION_AR, /(سكين|سكينه|سكاكين|شفره|موس|امواس|مشرط|كتر|منشار|فاس|ابره|حقنه|سرنجه|شنيور|دريل)/u),
    /(اقطع|هقطع|نقطع) (نفسي|جلدي|ايدي|يدي|صباعي|البطاريه)/u,
  ],
  glassware: [
    words('broken glass|glass shards?|shatter(s|ed|ing)?|heat(ing)? (a |the )?(glass|jar|bottle|test tube|beaker|flask)|(glass|jar|bottle) (on|over) (the )?(stove|fire|flame|burner)|seal(ed)? (bottle|jar) and heat|pressure in a (bottle|jar)'),
    /(زجاج مكسور|شظايا|(اسخن|سخن|نسخن|هسخن|تسخين) (الزجاج|زجاجه|الزجاجه|انبوبه|الانبوبه|برطمان|البرطمان|الدورق|البيكر)|(زجاجه|برطمان|انبوبه) (علي|فوق) (النار|البوتاجاز|الموقد|الشعله)|ينفجر الزجاج|ضغط في (زجاجه|برطمان))/u,
  ],
  ingestion: [
    words('(drink|taste|eat|swallow|lick|ingest) (it|this|that|them|some|the (acid|bleach|chemical|liquid|solution|powder|crystals|sample|mixture|substance))|put (it|this|some) in (my|the) mouth'),
    /((اشرب|نشرب|هشرب|اتذوق|اذوق|نذوق|اكل|ناكل|هاكل|ابلع|نبلع|الحس)(ه|ها|هم)?( (المحلول|الخليط|الماده|الكيماوي|العينه|السائل|البودره|الحمض|ده|دي|دول|شويه منه|منه|منها))|(احط|هحط)(ه|ها)? في (بقي|فمي|الفم))/u,
  ],
  skin_eye_contact: [
    words('on (my|the|your) skin|bare hands?|with my hands|in (my|the|your) eyes?|splash(es|ed|ing)? (in|on|into)|rub (it |this )?(on|into)|apply (it |this )?(to|on) (my|the) skin|(no|without) (gloves|goggles|protection|eye protection)'),
    /(علي (جلدي|الجلد|ايدي|يدي|ايديا|بشرتي)|بايدي|بايديا|بدون (قفاز|قفازات|نظاره|نظارات|حمايه)|من غير (قفاز|قفازات|نظاره|نظارات|حمايه)|في (عيني|العين|عينيا|عيوني|عينه)|يطرطش|رذاذ في|(افرك|هفرك)(ه|ها)? علي)/u,
  ],
  supervision: [
    both(
      words('experiment|try (it|this|that)|do (it|this|that)|make (it|this)|test (it|this)|reaction'),
      words('alone at home|home alone|at home (by myself|on my own|alone)|by myself|on my own|without (an |any )?adult|no adult|without (my |a )?(teacher|parents?|supervision|supervisor)|unsupervised|in my room|in the kitchen (alone|by myself)'),
    ),
    both(
      /(تجربه|التجربه|اجرب|نجرب|هجرب|اعمل|نعمل|هعمل|تفاعل)/u,
      /(لوحدي|لوحدنا|في البيت لوحدي|من غير (كبير|بالغ|مدرس|معلم|اشراف|ابويا|امي|ماما|بابا|حد)|بدون (كبير|بالغ|مدرس|معلم|اشراف|اهلي|حد)|في اوضتي|في المطبخ لوحدي|في البيت)/u,
    ),
  ],
};

function matches(matcher: Matcher, text: string): boolean {
  return typeof matcher === 'function' ? matcher(text) : matcher.test(text);
}

export interface GuardPreCheck {
  triggered: boolean;
  categories: HazardCategory[];
  /** The directive block to add to the prompt when triggered, else null. */
  directive: string | null;
}

/** Deterministic pre-check of the student message. */
export function preCheck(text: string): GuardPreCheck {
  const normalized = normalizeText(text);
  const categories: HazardCategory[] = [];
  for (const category of HAZARD_CATEGORIES) {
    if (LEXICON[category].some((matcher) => matches(matcher, normalized))) categories.push(category);
  }
  const triggered = categories.length > 0;
  return { triggered, categories, directive: triggered ? SAFETY_DIRECTIVE_TEXT : null };
}

// ---------------------------------------------------------------------------
// Post-check: operational hazard instructions in the reply
// ---------------------------------------------------------------------------

const QUANTITY = new RegExp(
  `${EDGE_L}\\d+([.,]\\d+)?\\s*(ml|mL|l|liters?|litres?|g|kg|grams?|mg|cups?|tablespoons?|teaspoons?|tbsp|tsp|drops?|مل|ملل|ملليلتر|لتر|جم|جرام|غرام|كجم|كيلو|ملعقه|ملاعق|كوب|اكواب|نقطه|نقاط|قطره|قطرات)${EDGE_R}`,
  'iu',
);

const HAZARDOUS_REAGENT = new RegExp(
  `${EDGE_L}(bleach|ammonia|chlorine|hydrochloric|sulfuric|sulphuric|nitric|acid|sodium hydroxide|lye|caustic|hydrogen peroxide|acetone|gasoline|petrol|kerosene|alcohol|ethanol|methanol|potassium (nitrate|permanganate|chlorate)|sodium metal|magnesium|thermite|mercury|drain cleaner)${EDGE_R}|(كلور|امونيا|نشادر|حمض|حامض|هيدروكلوريك|كبريتيك|نيتريك|صودا كاويه|هيدروكسيد|بيروكسيد|ماء اكسجين|اسيتون|بنزين|جاز|كيروسين|كحول|ايثانول|ميثانول|برمنجنات|نترات|كلورات|صوديوم|ماغنسيوم|مغنيسيوم|زئبق)`,
  'iu',
);

/** Numbered / bulleted / ordinal step markers at line starts (line structure preserved). */
const STEP_MARKER =
  /(^|\n)[ \t]*(\d+[.):\-]|[-*•]|(step|الخطوه|الخطوة)[ \t]*\d+[ \t]*[:.)\-]?|(اولا|ثانيا|ثالثا|رابعا|first|second|third)[:،,.]?)[ \t]/giu;

const OPERATIONAL_VERB = new RegExp(
  `${EDGE_L}(ignite|light (it|the|a)|set (it )?on fire|burn|heat (it|the|until|over|on|them)|boil|mix (it|them|the|with|in)|pour (it|the|in|into|them)|add (the|a|\\d)|combine|stir (in|the)|plug (it |the )?in|connect (the )?(wires?|battery)|strip the wire|touch the (wire|terminal))${EDGE_R}|(اشعل|اشعلي|اشعلوا|احرق|سخن|سخني|سخنوا|اغلي|اخلط|اخلطي|اخلطوا|امزج|امزجي|اسكب|اسكبي|صب|صبي|اضف|اضيفي|اضيفوا|قلب|قلبي|وصل (السلك|الاسلاك|البطاريه)|اقشر السلك|المس (السلك|الطرف))`,
  'iu',
);

export interface GuardPostCheck {
  violation: boolean;
  /** Which rule fired: `quantity_reagent` or `operational_sequence`. */
  rule: 'quantity_reagent' | 'operational_sequence' | null;
}

/**
 * Post-check of the completed reply. A violation is (a) a quantity within
 * the same sentence as a hazardous reagent, or (b) a step sequence (≥ 2
 * markers) carrying an ignition/mixing/heating/wiring verb together with a
 * hazard term.
 */
export function postCheck(output: string): GuardPostCheck {
  // Line structure is kept for the step markers; everything else is matched
  // on the whitespace-collapsed normalised form like the pre-check.
  const lined = normalizeArabic(output).toLowerCase();
  const normalized = normalizeText(output);
  for (const sentence of lined.split(/[.!?؟\n]+/)) {
    if (QUANTITY.test(sentence) && HAZARDOUS_REAGENT.test(sentence)) {
      return { violation: true, rule: 'quantity_reagent' };
    }
  }
  const stepMarkers = (lined.match(STEP_MARKER) ?? []).length;
  if (stepMarkers >= 2 && OPERATIONAL_VERB.test(normalized)) {
    const hazard =
      HAZARDOUS_REAGENT.test(normalized) ||
      HAZARD_CATEGORIES.some((category) =>
        LEXICON[category].some((matcher) => matches(matcher, normalized)),
      );
    if (hazard) return { violation: true, rule: 'operational_sequence' };
  }
  return { violation: false, rule: null };
}

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

/** Fixed, supportive, bilingual boundary reply (SAFE-02). */
export const SAFETY_BOUNDARY_MESSAGE = `I can't help with the steps for that method because it could hurt you. The idea you want to understand is a good one, and I'm happy to explain it and to suggest a safe way to explore it — for example a supervised school-lab version, a simulation, or a worked example. What is the concept you want to learn?

لا أستطيع المساعدة في خطوات هذه الطريقة لأنها قد تؤذيك. الفكرة التي تريد فهمها جيدة، ويسعدني أن أشرحها وأقترح طريقة آمنة لاستكشافها — مثل نسخة تحت إشراف في مختبر المدرسة، أو محاكاة، أو مثال محلول. ما المفهوم الذي تريد تعلمه؟`;

export const SAFETY_BOUNDARY_CODE = 'SAFETY_BOUNDARY' as const;

export type GuardResult<T> = { ok: true; value: T } | { ok: false; boundary: string; error: string };

/**
 * Run a guard step; any exception becomes the boundary (SAFE-02). The error
 * name (never the text) is returned for the log line.
 */
export function guardOrBoundary<T>(run: () => T): GuardResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return {
      ok: false,
      boundary: SAFETY_BOUNDARY_MESSAGE,
      error: error instanceof Error ? error.name : 'Error',
    };
  }
}

/** The `safety` object stored on the tutor message and sent on `done` (contracts §3.4). */
export interface SafetyRecord {
  triggered: boolean;
  category: HazardCategory | null;
  categories: HazardCategory[];
  /** True when the reply IS the boundary message. */
  boundary: boolean;
  /** `SAFETY_BOUNDARY` when boundary, else absent. */
  code?: typeof SAFETY_BOUNDARY_CODE;
  /** Why the boundary was applied: post-check rule or `guard_error`. */
  reason?: 'quantity_reagent' | 'operational_sequence' | 'guard_error';
}

export function safetyRecord(
  pre: GuardPreCheck,
  boundary: { applied: false } | { applied: true; reason: NonNullable<SafetyRecord['reason']> },
): SafetyRecord {
  const base: SafetyRecord = {
    triggered: pre.triggered || boundary.applied,
    category: pre.categories[0] ?? null,
    categories: pre.categories,
    boundary: boundary.applied,
  };
  return boundary.applied
    ? { ...base, code: SAFETY_BOUNDARY_CODE, reason: boundary.reason }
    : base;
}

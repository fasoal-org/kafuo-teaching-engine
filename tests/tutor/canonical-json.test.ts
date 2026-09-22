import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalHelpTurnRequest,
  canonicalJson,
  computeHelpTurnDigest,
} from '@/lib/server/tutor/canonical-json';

/**
 * Golden digest for the legacy help-turn endpoint (contracts §3.4). The
 * expected hex was produced by the Backend's exact call:
 *
 *   json.dumps(body_without_actorRef_and_requestDigest, sort_keys=True,
 *              separators=(",", ":"), ensure_ascii=False).encode("utf-8")
 *
 * over this very body (Arabic text, nested objects, null fields, integers,
 * a backslash and a tab inside a string). A canonicaliser drift on either
 * side fails this test rather than producing TURN_DIGEST_CONFLICTs in
 * production.
 */
const GOLDEN_BODY: Record<string, unknown> = {
  tenantContext: { tenantId: '1' },
  origin: 'kafuo_backend',
  turnId: 'kafuo:conv:123:cm-abc',
  requestDigest: 'x',
  studentRef: 'abcdefghijklmnopqrstuvwx',
  subject: { code: 'PHYSICS', nameAr: 'الفيزياء', nameEn: 'Physics', academicLanguage: 'ar' },
  academic: { curriculumName: 'المنهج الوطني', curriculumVersionLabel: '2026', gradeLabel: 'الصف التاسع' },
  lesson: { learningItemType: 'lesson', learningItemId: '77', title: 'قانون نيوتن الثاني' },
  helpScope: { kind: 'help_linked_chat', label: 'مساعدة', cardKey: null, stepNumber: 3, intent: null },
  grounding: {
    units: [
      {
        unitId: 'u-1',
        title: 'القوة والتسارع',
        text: 'القوة = الكتلة × التسارع.\nهذا هو قانون نيوتن الثاني "F = ma".',
        charLength: 52,
      },
    ],
    truncated: false,
  },
  history: [
    { role: 'student', text: 'ما هو القانون؟' },
    { role: 'tutor', text: 'القانون يربط القوة بالتسارع.' },
  ],
  message: { text: 'اشرح لي مثال \\ بسيط \t' },
  localeHint: 'ar',
  legacyHelpLinkRef: 'link:55',
  actorRef: 'actor-1',
};

const GOLDEN_CANONICAL =
  '{"academic":{"curriculumName":"المنهج الوطني","curriculumVersionLabel":"2026","gradeLabel":"الصف التاسع"},"grounding":{"truncated":false,"units":[{"charLength":52,"text":"القوة = الكتلة × التسارع.\\nهذا هو قانون نيوتن الثاني \\"F = ma\\".","title":"القوة والتسارع","unitId":"u-1"}]},"helpScope":{"cardKey":null,"intent":null,"kind":"help_linked_chat","label":"مساعدة","stepNumber":3},"history":[{"role":"student","text":"ما هو القانون؟"},{"role":"tutor","text":"القانون يربط القوة بالتسارع."}],"legacyHelpLinkRef":"link:55","lesson":{"learningItemId":"77","learningItemType":"lesson","title":"قانون نيوتن الثاني"},"localeHint":"ar","message":{"text":"اشرح لي مثال \\\\ بسيط \\t"},"origin":"kafuo_backend","studentRef":"abcdefghijklmnopqrstuvwx","subject":{"academicLanguage":"ar","code":"PHYSICS","nameAr":"الفيزياء","nameEn":"Physics"},"tenantContext":{"tenantId":"1"},"turnId":"kafuo:conv:123:cm-abc"}';

const GOLDEN_DIGEST = '72654016844727743df8dbf6f3dd58d5647e172e99eaa8a9d697bdef9b94b742';

describe('canonical JSON (Python json.dumps sort_keys, no whitespace, ensure_ascii=False)', () => {
  it('matches the Backend byte for byte on the golden body', () => {
    expect(canonicalHelpTurnRequest(GOLDEN_BODY)).toBe(GOLDEN_CANONICAL);
    expect(computeHelpTurnDigest(GOLDEN_BODY)).toBe(GOLDEN_DIGEST);
    expect(createHash('sha256').update(Buffer.from(GOLDEN_CANONICAL, 'utf8')).digest('hex')).toBe(GOLDEN_DIGEST);
  });

  it('strips actorRef and requestDigest at the top level only', () => {
    const withoutBoth = { ...GOLDEN_BODY };
    delete withoutBoth.actorRef;
    delete withoutBoth.requestDigest;
    expect(computeHelpTurnDigest(withoutBoth)).toBe(GOLDEN_DIGEST);
    expect(computeHelpTurnDigest({ ...GOLDEN_BODY, actorRef: 'someone-else', requestDigest: 'y' })).toBe(GOLDEN_DIGEST);
    // A nested `actorRef` is data and stays.
    expect(canonicalJson({ a: { actorRef: 1 } })).toBe('{"a":{"actorRef":1}}');
  });

  it('sorts keys recursively by code point, keeps null, integers plain, arrays ordered', () => {
    expect(canonicalJson({ b: 1, a: { d: null, c: [3, 1, { z: true, y: 'س' }] }, Z: 2 })).toBe(
      '{"Z":2,"a":{"c":[3,1,{"y":"س","z":true}],"d":null},"b":1}',
    );
    expect(canonicalJson({ n: 10, f: 0.5 })).toBe('{"f":0.5,"n":10}');
  });

  it('drops undefined values (absent on the wire) and refuses non-finite numbers', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

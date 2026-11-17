import { describe, expect, it } from 'vitest';

import { asksForTry } from '@/lib/server/teaching-package/try-prompt';

describe('asksForTry (lesson 2-5, item 214 scene 33)', () => {
  it('finds the try lines that sat beside the answer on the solution slide', () => {
    expect(
      asksForTry('<p>تمرين 2 (س14 في كتابك) : اكتب المعادلة ومثّلها بيانيًا قبل قراءة الحل.</p>'),
    ).toBe(true);
    expect(asksForTry('خذوا وقتكم في كتابة المعادلة وتمثيلها بيانيًا قبل ما تتابعون الحل.')).toBe(
      true,
    );
    expect(asksForTry('قبل ما نكشف الحلول، انتبهوا لمعطيات التمرين الثاني.')).toBe(true);
    expect(asksForTry('جرّبوا بأنفسكم قبل المتابعة.')).toBe(true);
  });

  it('leaves ordinary solution lines alone', () => {
    expect(asksForTry('بالتعويض، المعادلة هي: صاد يساوي سالب سبعة سين ناقص أربعة.')).toBe(false);
    expect(asksForTry('نعوّض بإحداثيي النقطة والميل، فنحصل على المعادلة.')).toBe(false);
    expect(asksForTry(undefined)).toBe(false);
  });
});

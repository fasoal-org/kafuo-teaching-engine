import { describe, expect, it } from 'vitest';

import { classroomStageIdFromPathname } from '@/lib/access-code/classroom-stage-id';

describe('classroomStageIdFromPathname', () => {
  it('returns the id for exactly /classroom/<id>', () => {
    expect(classroomStageIdFromPathname('/classroom/stage-9_Ab')).toBe('stage-9_Ab');
    expect(classroomStageIdFromPathname('/classroom/s')).toBe('s');
  });

  it('returns null for anything else', () => {
    expect(classroomStageIdFromPathname('/')).toBeNull();
    expect(classroomStageIdFromPathname('/classroom')).toBeNull();
    expect(classroomStageIdFromPathname('/classroom/')).toBeNull();
    expect(classroomStageIdFromPathname('/classroom/a/b')).toBeNull();
    // An encoded slash decodes to a multi-segment id: rejected by the charset.
    expect(classroomStageIdFromPathname('/classroom/a%2Fb')).toBeNull();
    expect(classroomStageIdFromPathname('/classroom/..')).toBeNull();
    expect(classroomStageIdFromPathname('/classroom/a.b')).toBeNull();
    expect(classroomStageIdFromPathname('/workbench')).toBeNull();
    expect(classroomStageIdFromPathname(null)).toBeNull();
    expect(classroomStageIdFromPathname('')).toBeNull();
  });
});

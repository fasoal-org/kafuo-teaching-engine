import { describe, expect, it } from 'vitest';

import { validateAppStage } from '@/lib/document-store/validators';
import { sanitizeAudioProvenance } from '@/lib/types/action';
import { isSpeechReadingMode } from '@/lib/types/stage';

const stage = { id: 'stage-1', name: 'Stage', createdAt: 1, updatedAt: 2 };

function paths(result: ReturnType<typeof validateAppStage>): string[] {
  return result.valid ? [] : result.errors.map((error) => error.path);
}

describe('validateAppStage — Stage.subjectCode / Stage.speechReadingMode', () => {
  it('accepts a legacy stage without the new fields', () => {
    expect(validateAppStage(stage)).toEqual({ valid: true });
  });

  it.each(['MATH', 'PHYSICS', 'CHEMISTRY', 'SOCIAL_STUDIES', 'GEOLOGY'])(
    'accepts the well-formed subject code %s (known or not)',
    (subjectCode) => {
      expect(validateAppStage({ ...stage, subjectCode })).toEqual({ valid: true });
    },
  );

  it.each(['math', 'M', 'MATH-1', 'MATH 2', 'A'.repeat(33)])(
    'rejects the malformed subject code %s at /subjectCode',
    (subjectCode) => {
      expect(paths(validateAppStage({ ...stage, subjectCode }))).toEqual(['/subjectCode']);
    },
  );

  it('reports an empty subject code once, from the DSL validator', () => {
    expect(paths(validateAppStage({ ...stage, subjectCode: ' ' }))).toEqual(['/subjectCode']);
  });

  it('keeps the existing currentSceneId rule alongside the subject rule', () => {
    expect(paths(validateAppStage({ ...stage, currentSceneId: 's', subjectCode: 'x' }))).toEqual([
      '/currentSceneId',
      '/subjectCode',
    ]);
  });

  it('validates the reading mode through the DSL', () => {
    expect(validateAppStage({ ...stage, speechReadingMode: 'accessible' })).toEqual({
      valid: true,
    });
    expect(paths(validateAppStage({ ...stage, speechReadingMode: 'slow' }))).toEqual([
      '/speechReadingMode',
    ]);
    expect(isSpeechReadingMode('natural')).toBe(true);
  });

  it('re-exports the provenance sanitizer for app consumers', () => {
    expect(sanitizeAudioProvenance({ fingerprint: 'x' })).toBeUndefined();
  });
});

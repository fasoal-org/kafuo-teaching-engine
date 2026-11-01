import type { OutlineDiagnostic } from '@openmaic/generation';
import { describe, expect, it } from 'vitest';

import {
  applyCorrectionOperations,
  diagnosticKey,
  ignoredIssueKeys,
  isIgnorableIssue,
  parseCorrectionOperations,
  withoutIgnoredIssues,
} from '@/lib/server/teaching-package/outline-correction';
import type { SceneOutline } from '@/lib/types/generation';
import type {
  GenerationCheckpointLogEntry,
  GenerationCheckpointSourceRefs,
} from '@/lib/types/teaching-package';

const issue = (extra: Partial<OutlineDiagnostic> = {}): OutlineDiagnostic =>
  ({
    code: 'CONTENT_ROLE_NOT_ALLOWED',
    disposition: 'admin_correctable',
    outlineIndex: 4,
    outlineId: 'o-visual',
    field: 'contentRole',
    message: 'outline #5 ("o-visual") has a role this position does not allow',
    ...extra,
  }) as OutlineDiagnostic;

describe('ignore_issue correction', () => {
  it('parses an ignore without an outline id', () => {
    expect(parseCorrectionOperations([{ op: 'ignore_issue', issueKey: 'k' }])).toEqual([
      { op: 'ignore_issue', issueKey: 'k' },
    ]);
    expect(() => parseCorrectionOperations([{ op: 'ignore_issue' }])).toThrow(/issueKey/);
  });

  it('keys an issue by its outline id, not its position', () => {
    const moved = issue({
      outlineIndex: 6,
      message: 'outline #7 ("o-visual") has a role this position does not allow',
    });
    expect(diagnosticKey(moved)).toBe(diagnosticKey(issue()));
    expect(diagnosticKey(issue({ outlineId: 'o-other' }))).not.toBe(diagnosticKey(issue()));
    expect(diagnosticKey(issue({ code: 'GROUNDING_MISSING' }))).not.toBe(diagnosticKey(issue()));
    // A repair that rewrites the wording keeps a slide issue's key.
    expect(diagnosticKey(issue({ message: 'received 3 selections' }))).toBe(diagnosticKey(issue()));
  });

  it('tells whole-outline issues apart by the book element they name', () => {
    const gap = (unit: string) =>
      issue({
        code: 'BOOK_COVERAGE_INCOMPLETE',
        outlineId: undefined,
        outlineIndex: undefined,
        field: 'sourceContentUnitIds',
        message: `UNDERSTANDING_CHECK ${unit} in part 2 has a try-it slide but no solution slide after it`,
      });
    expect(diagnosticKey(gap('4028'))).not.toBe(diagnosticKey(gap('4032')));
  });

  it('allows an ignore only where it does not just postpone a failure', () => {
    expect(isIgnorableIssue(issue())).toBe(true);
    expect(
      isIgnorableIssue(issue({ code: 'BOOK_COVERAGE_INCOMPLETE', outlineId: undefined })),
    ).toBe(true);
    for (const code of [
      'TEACHING_STAGE_MISSING',
      'POSITION_CARDINALITY',
      'FLOW_SEQUENCE_INVALID',
      'SCENE_CONFIG_INVALID',
      'WIDGET_TYPE_PROHIBITED',
    ]) {
      expect(isIgnorableIssue(issue({ code }))).toBe(false);
    }
    expect(isIgnorableIssue(issue({ field: 'teachingStage' }))).toBe(false);
    // Never blocking anyway: nothing to ignore.
    expect(isIgnorableIssue(issue({ code: 'VISUAL_TEACHING_NOTE_MISSING' }))).toBe(false);
    expect(isIgnorableIssue(issue({ field: 'scene' }))).toBe(false);
  });

  it('reads ignored keys from the edit log and the pending operations', () => {
    const log = [
      { revision: 1, event: 'paused', actorRef: 'system', at: 1 },
      {
        revision: 2,
        event: 'edited',
        actorRef: 'kafuo:admin-1',
        at: 2,
        operations: [
          { op: 'set', outlineId: 'o', field: 'type', value: 'slide' },
          { op: 'ignore_issue', issueKey: 'a' },
        ],
      },
    ] as GenerationCheckpointLogEntry[];
    expect([...ignoredIssueKeys(log, [{ op: 'ignore_issue', issueKey: 'b' }])]).toEqual(['a', 'b']);
  });

  it('filters only the ignored issues', () => {
    const other = issue({ outlineId: 'o-other' });
    expect(withoutIgnoredIssues([issue(), other], new Set([diagnosticKey(issue())]))).toEqual([
      other,
    ]);
  });

  it('changes no outline', () => {
    const outlines = [{ id: 'o-1', type: 'slide', title: 't' }] as SceneOutline[];
    const edited = applyCorrectionOperations(outlines, [{ op: 'ignore_issue', issueKey: 'k' }], {
      phase: 'scenes',
      flow: [],
      sourceRefs: { sourceImages: [] } as unknown as GenerationCheckpointSourceRefs,
      pendingOutlineIds: [],
    });
    expect(edited).toEqual([{ ...outlines[0], order: 1 }]);
  });
});

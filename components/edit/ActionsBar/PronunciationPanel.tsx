'use client';

/**
 * Reviewer "Pronunciation" disclosure for one speech line (SATTS plan §16.3,
 * FR-010, FR-036): the original and the spoken (prepared) text side by side,
 * the renderer warnings with their source text highlighted, the audio status,
 * and a non-persisting "preview spoken form". Rendered only for owners/editors
 * and only while the server's scientific mode is active; never in learner mode.
 */
import { useState } from 'react';

import { useMayGenerateForStage } from '@/lib/classroom/generation-permission';
import { useI18n } from '@/lib/hooks/use-i18n';
import { isScientificSpeechActive } from '@/lib/speech/scientific-mode';
import { useSettingsStore } from '@/lib/store/settings';
import { useStageStore } from '@/lib/store/stage';

interface Diagnostics {
  original: string;
  prepared: string;
  path: 'general' | 'scientific';
  warnings: Array<{ code: string; severity: string; source: { start: number; end: number } }>;
  status: 'current' | 'stale' | 'legacy' | 'missing';
  staleReason?: string;
  policyVersion: string | null;
  policyStatus: string;
}

async function postDiagnostics(body: Record<string, unknown>) {
  const response = await fetch('/api/speech/diagnostics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`diagnostics ${response.status}`);
  return (await response.json()) as {
    actions: Diagnostics[];
    preview?: { base64: string; format: string };
  };
}

/** Hidden unless the server's scientific mode is active and the viewer may edit. */
function usePronunciationSurfaces(): boolean {
  const mode = useSettingsStore((state) => state.scientificSpeechMode);
  const mayEdit = useMayGenerateForStage(useStageStore((state) => state.stage?.id));
  return isScientificSpeechActive(mode) && mayEdit;
}

export function PronunciationPanel({ actionId, sceneId }: { actionId: string; sceneId?: string }) {
  const { t } = useI18n();
  const visible = usePronunciationSurfaces();
  const stageId = useStageStore((state) => state.stage?.id);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Diagnostics | null>(null);
  const [failed, setFailed] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const tts = () => {
    const settings = useSettingsStore.getState();
    return {
      ttsProviderId: settings.ttsProviderId,
      ttsModelId: settings.ttsProvidersConfig?.[settings.ttsProviderId]?.modelId,
      ttsVoice: settings.ttsVoice,
      ttsSpeed: settings.ttsSpeed,
    };
  };

  const load = async () => {
    if (!stageId) return;
    setFailed(false);
    try {
      const result = await postDiagnostics({ stageId, sceneId, actionIds: [actionId], ...tts() });
      setData(result.actions[0] ?? null);
    } catch {
      setFailed(true);
    }
  };

  const preview = async () => {
    if (!stageId) return;
    setPreviewing(true);
    try {
      const result = await postDiagnostics({ stageId, sceneId, actionIds: [actionId], synthesize: true, ...tts() });
      if (result.preview) {
        await new Audio(`data:audio/${result.preview.format};base64,${result.preview.base64}`).play();
      }
    } catch {
      setFailed(true);
    } finally {
      setPreviewing(false);
    }
  };

  const statusLabel = (d: Diagnostics) =>
    d.status === 'current'
      ? t('edit.pronunciation.statusCurrent')
      : d.status === 'stale'
        ? t('edit.pronunciation.statusStale', { reason: d.staleReason ?? '' })
        : d.status === 'legacy'
          ? t('edit.pronunciation.statusLegacy')
          : t('edit.pronunciation.statusMissing');

  if (!visible) return null;
  return (
    <div className="border-t border-border/40 px-3 py-1.5 text-[11.5px]" data-testid="pronunciation-panel">
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        {t('edit.pronunciation.title')}
      </button>
      {open && failed && <p className="mt-1 text-destructive">{t('edit.pronunciation.unavailable')}</p>}
      {open && data && (
        <div className="mt-1.5 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5">{statusLabel(data)}</span>
            {data.path === 'general' ? (
              <span className="text-muted-foreground">{t('edit.pronunciation.generalPath')}</span>
            ) : (
              <span className="text-muted-foreground">
                {t('edit.pronunciation.policy', {
                  version: data.policyVersion ?? '',
                  status: data.policyStatus,
                })}
              </span>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <div>
              <div className="text-muted-foreground">{t('edit.pronunciation.original')}</div>
              <p dir="auto" className="whitespace-pre-wrap">
                {data.original}
              </p>
            </div>
            <div>
              <div className="text-muted-foreground">{t('edit.pronunciation.prepared')}</div>
              <p dir="auto" className="whitespace-pre-wrap">
                {data.prepared}
              </p>
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">{t('edit.pronunciation.warnings')}</div>
            {data.warnings.length === 0 ? (
              <p>{t('edit.pronunciation.noWarnings')}</p>
            ) : (
              <ul className="list-disc ps-4">
                {data.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`}>
                    <code>{warning.code}</code>{' '}
                    <mark dir="ltr">{data.original.slice(warning.source.start, warning.source.end)}</mark>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
            disabled={previewing}
            onClick={() => void preview()}
          >
            {t('edit.pronunciation.preview')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Stage-level narration reading mode (D-4b), owners/editors only. */
export function SpeechReadingModeSetting() {
  const { t } = useI18n();
  const visible = usePronunciationSurfaces();
  const mode = useStageStore((state) => state.stage?.speechReadingMode ?? 'natural');
  const setMode = useStageStore((state) => state.setSpeechReadingMode);
  if (!visible) return null;
  return (
    <label className="flex items-center gap-2 px-3 py-1 text-[11.5px] text-muted-foreground" data-testid="speech-reading-mode">
      {t('edit.pronunciation.readingMode')}
      <select
        className="rounded border border-border bg-transparent px-1 py-0.5 text-foreground"
        value={mode}
        onChange={(event) => setMode(event.target.value === 'accessible' ? 'accessible' : 'natural')}
      >
        <option value="natural">{t('edit.pronunciation.readingModeNatural')}</option>
        <option value="accessible">{t('edit.pronunciation.readingModeAccessible')}</option>
      </select>
    </label>
  );
}

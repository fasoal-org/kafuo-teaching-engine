'use client';

/**
 * AI-voice disclosure on web playback (FR-034, OpenAI usage policy P13, D-3):
 * a persistent «AI voice» label next to the sound control and a one-time,
 * dismissible first-play notice. Shown only when the current scene has
 * generated narration (never for captions-only playback) and — so the flag-off
 * product is unchanged — only while the server's scientific mode is active
 * (DEC-033; enabling the disclosure independently is a human gate).
 */
import { useState } from 'react';

import { useI18n } from '@/lib/hooks/use-i18n';
import { isScientificSpeechActive } from '@/lib/speech/scientific-mode';
import { useSettingsStore } from '@/lib/store/settings';
import { useStageStore } from '@/lib/store/stage';

/** Once per device (browser profile), per D-3 "once per learner account per device". */
export const AI_VOICE_NOTICE_KEY = 'satts_ai_voice_notice_v1';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(AI_VOICE_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

function useSceneHasGeneratedNarration(): boolean {
  return useStageStore((state) => {
    const scene = state.scenes.find((s) => s.id === state.currentSceneId);
    return (scene?.actions ?? []).some(
      (action) => action.type === 'speech' && Boolean((action as { audioId?: string }).audioId),
    );
  });
}

export function AiVoiceDisclosure() {
  const { t } = useI18n();
  const mode = useSettingsStore((state) => state.scientificSpeechMode);
  const voiced = useSceneHasGeneratedNarration();
  const [dismissed, setDismissed] = useState(() => typeof window === 'undefined' || readDismissed());

  if (!isScientificSpeechActive(mode) || !voiced) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(AI_VOICE_NOTICE_KEY, '1');
    } catch {
      // storage unavailable: the notice returns next session, which is acceptable
    }
  };

  return (
    <span className="relative flex items-center" data-testid="ai-voice-disclosure">
      <span className="ms-1 select-none whitespace-nowrap text-[10px] text-gray-500 dark:text-gray-400">
        {t('aiVoice.label')}
      </span>
      {!dismissed && (
        <span
          role="status"
          className="absolute bottom-full start-0 mb-2 w-64 rounded-lg border border-gray-200 bg-white p-2 text-[11px] text-gray-700 shadow-lg dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
          data-testid="ai-voice-notice"
        >
          <span className="block" dir="auto">
            {t('aiVoice.notice')}
          </span>
          <button type="button" className="mt-1 text-violet-600 dark:text-violet-400" onClick={dismiss}>
            {t('aiVoice.dismiss')}
          </button>
        </span>
      )}
    </span>
  );
}

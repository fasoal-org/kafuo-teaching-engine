import {
  getServerProviders,
  getServerTTSProviders,
  getServerASRProviders,
  getServerPDFProviders,
  getServerImageProviders,
  getServerVideoProviders,
  getServerWebSearchProviders,
  getParallelSceneConcurrency,
} from '@/lib/server/provider-config';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { readSpeechConfig } from '@/lib/server/speech/config';
import { createLogger } from '@/lib/logger';
import {
  accessCodeRequiredResponse,
  hasAccessCookieOrTeacherGrant,
} from '@/lib/server/teaching-package/editor-grant-tenant-access';

const log = createLogger('ServerProviders');

export async function GET(req: Request) {
  // Teacher voice (owner, 22 Nov 2026): the editor reads this to know the server
  // voices lessons; a teacher without the access code reads it with an editor grant.
  if (!hasAccessCookieOrTeacherGrant(req.headers)) return accessCodeRequiredResponse();
  try {
    return apiSuccess({
      providers: getServerProviders(),
      tts: getServerTTSProviders(),
      asr: getServerASRProviders(),
      pdf: getServerPDFProviders(),
      image: getServerImageProviders(),
      video: getServerVideoProviders(),
      webSearch: getServerWebSearchProviders(),
      generation: {
        parallelSceneConcurrency: getParallelSceneConcurrency(),
      },
      // SATTS: lets the browser keep its narration requests identical to today's while off.
      speech: { scientificMode: readSpeechConfig().mode },
    });
  } catch (error) {
    log.error('Error fetching server providers:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error',
    );
  }
}

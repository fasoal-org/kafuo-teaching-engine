'use client';

import { useEffect, useState, ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { AccessCodeModal } from '@/components/access-code-modal';
import { classroomStageIdFromPathname } from '@/lib/access-code/classroom-stage-id';
import { useSettingsStore } from '@/lib/store/settings';

export function AccessCodeGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // The classroom the browser is actually opening, if this page is one: an editor
  // handoff's Stage-scoped grant covers exactly that classroom and no other page.
  const stageId = classroomStageIdFromPathname(pathname);
  const [status, setStatus] = useState<{
    enabled: boolean;
    authenticated: boolean;
    editorGrantCovered: boolean;
    loading: boolean;
  }>({ enabled: false, authenticated: false, editorGrantCovered: false, loading: true });

  useEffect(() => {
    let cancelled = false;
    // With a classroom Stage id the status route also checks the editor grant
    // (owner, 21 Nov 2026): a handoff-redeemed browser opens its own classroom
    // without the access-code modal. Without one the question is unchanged.
    const url = stageId
      ? `/api/access-code/status?stageId=${encodeURIComponent(stageId)}`
      : '/api/access-code/status';
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setStatus({
            enabled: data.enabled,
            authenticated: data.authenticated,
            editorGrantCovered: Boolean(data.editorGrantCovered),
            loading: false,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Default to requiring auth on error — safer than silently disabling
          setStatus({
            enabled: true,
            authenticated: false,
            editorGrantCovered: false,
            loading: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [stageId]);

  const needsAuth =
    !status.loading && status.enabled && !status.authenticated && !status.editorGrantCovered;

  return (
    <>
      {needsAuth && (
        <AccessCodeModal
          open={true}
          onSuccess={() => {
            setStatus((s) => ({ ...s, authenticated: true }));
            // ServerProvidersInit runs on mount, which on an ACCESS_CODE-gated
            // deployment is before any access cookie exists: the middleware
            // answers 401 and the store silently keeps its blank defaults.
            // Nothing re-fetches afterwards, so every server-configured
            // provider reads as unconfigured until a manual reload. Re-fetch
            // now that the request will be authorized.
            void useSettingsStore.getState().fetchServerProviders();
          }}
        />
      )}
      {children}
    </>
  );
}

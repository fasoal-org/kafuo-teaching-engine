'use client';

import Canvas from './Canvas';
import type { StageMode } from '@/lib/types/stage';
import { PlaybackScreenCanvas } from './ScreenCanvas';

/**
 * Slide Editor - wraps Canvas with SceneProvider
 */
export function SlideEditor({ mode }: { readonly mode: StageMode }) {
  return (
    // `dir="ltr"`: slide elements sit at absolute coordinates, which an RTL page must
    // not mirror.
    <div dir="ltr" className="flex flex-col h-full">
      <div className="flex-1 overflow-hidden">
        {mode === 'autonomous' ? <Canvas /> : <PlaybackScreenCanvas />}
      </div>
    </div>
  );
}

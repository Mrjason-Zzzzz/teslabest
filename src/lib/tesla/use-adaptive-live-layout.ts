'use client';

import { useCallback, useEffect, useState } from 'react';

import { shouldUseCompactVehicleLayout } from './viewport-mode';

export type LiveLayoutMode = 'auto' | 'compact' | 'standard';

const STORAGE_KEY = 'dorezst:live-layout-mode:v1';

function isLiveLayoutMode(value: string | null): value is LiveLayoutMode {
  return value === 'auto' || value === 'compact' || value === 'standard';
}

/**
 * Keeps layout preference on the current browser only. The chosen density
 * changes navigation and scrolling, never the media decoding/playback mode.
 */
export function useAdaptiveLiveLayout() {
  const [mode, setMode] = useState<LiveLayoutMode>('auto');
  const [autoCompact, setAutoCompact] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLiveLayoutMode(saved)) setMode(saved);
  }, []);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const viewport = window.visualViewport;
        setAutoCompact(
          shouldUseCompactVehicleLayout({
            width: viewport?.width || window.innerWidth,
            height: viewport?.height || window.innerHeight,
            physicalWidth: window.screen?.width,
            frameWidth: window.outerWidth,
            scale: viewport?.scale,
          })
        );
      });
    };

    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);

  const chooseMode = useCallback((next: LiveLayoutMode) => {
    setMode(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return {
    mode,
    chooseMode,
    isCompact: mode === 'compact' || (mode === 'auto' && autoCompact),
  };
}

export type TeslaPlaybackMode = 'video' | 'webcodecs';
export type TeslaVodPlaybackPreference = TeslaPlaybackMode | 'auto';

export interface TeslaVodEnvironment {
  maxTouchPoints: number;
  hasCoarsePointer: boolean;
  hasNoHover: boolean;
  viewportWidth: number;
  viewportHeight: number;
}

/**
 * Ordinary desktop VOD benefits from the browser's native media clock and
 * avoids a WebAudio unlock. A wide touch-only surface stays on Canvas. This
 * deliberately does not use the browser user-agent: recent Tesla releases
 * can identify as generic Chromium/Linux.
 */
export function selectTeslaVodDefaultMode(
  environment: TeslaVodEnvironment
): TeslaPlaybackMode {
  const isWideTouchSurface =
    environment.maxTouchPoints > 0 &&
    environment.hasCoarsePointer &&
    environment.hasNoHover &&
    environment.viewportWidth >= 720 &&
    environment.viewportWidth >= environment.viewportHeight * 1.2;

  return isWideTouchSurface ? 'webcodecs' : 'video';
}

export function resolveTeslaVodDefaultMode(): TeslaPlaybackMode {
  if (typeof window === 'undefined') return 'webcodecs';
  const matches = (query: string) => {
    try {
      return window.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  };
  return selectTeslaVodDefaultMode({
    maxTouchPoints: navigator.maxTouchPoints || 0,
    hasCoarsePointer: matches('(pointer: coarse)'),
    hasNoHover: matches('(hover: none)'),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });
}

export function selectTeslaPlaybackMode(
  wanted: TeslaPlaybackMode,
  webCodecsSupported: boolean
): TeslaPlaybackMode {
  // Tesla's browser user-agent is not a stable contract: recent vehicle
  // releases may present as a generic Chromium/Linux browser. A UA split
  // therefore routes a moving vehicle to the native video layer, which can be
  // blanked while driving. Keep the established capability-based rule: the
  // Tesla route requests WebCodecs and uses Canvas whenever it is available.
  return wanted === 'webcodecs' && webCodecsSupported ? 'webcodecs' : 'video';
}

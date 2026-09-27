export type TeslaPlaybackMode = 'video' | 'webcodecs';

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

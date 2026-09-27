export type TeslaPlaybackMode = 'video' | 'webcodecs';

/**
 * Canvas/WebCodecs is mandatory for the moving-car renderer, where the native
 * video layer can be blanked by the vehicle browser. Desktop browsers do not
 * have that restriction and their native media clock is the more compatible
 * A/V master for ordinary playback verification.
 */
export function isTeslaVehicleBrowser(userAgent: string): boolean {
  return /tesla|qtcarbrowser|teslabrowser|teslaos|carbrowser/i.test(userAgent);
}

export function selectTeslaPlaybackMode(
  wanted: TeslaPlaybackMode,
  webCodecsSupported: boolean,
  userAgent: string
): TeslaPlaybackMode {
  if (
    wanted === 'webcodecs' &&
    webCodecsSupported &&
    isTeslaVehicleBrowser(userAgent)
  ) {
    return 'webcodecs';
  }
  return 'video';
}

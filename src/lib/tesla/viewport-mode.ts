export interface EffectiveViewport {
  width: number;
  height: number;
  physicalWidth?: number;
}

/**
 * Detects a browser whose usable CSS viewport has been materially compressed
 * versus its screen. This covers desktop zoom and Tesla's post-update layout
 * scaling without relying on a device user-agent or an exact zoom percentage.
 */
export function shouldUseCompactVehicleLayout({
  width,
  height,
  physicalWidth,
}: EffectiveViewport): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 640)
    return false;

  const stablePhysicalWidth =
    Number.isFinite(physicalWidth) && (physicalWidth || 0) > 0
      ? (physicalWidth as number)
      : width;
  const hasCompressedEffectiveWidth = width / stablePhysicalWidth < 0.86;
  const hasShortWideViewport =
    width >= 768 && height <= 700 && width / Math.max(height, 1) >= 1.5;

  return hasCompressedEffectiveWidth || hasShortWideViewport;
}

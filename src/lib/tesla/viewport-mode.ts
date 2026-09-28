export interface EffectiveViewport {
  width: number;
  height: number;
  physicalWidth?: number;
  /** Browser window width before page zoom, when the browser exposes it. */
  frameWidth?: number;
  /** visualViewport scale, when the browser exposes it. */
  scale?: number;
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
  frameWidth,
  scale,
}: EffectiveViewport): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 640)
    return false;

  const references = [physicalWidth, frameWidth]
    .filter((value): value is number => Number.isFinite(value) && value! >= width)
    .sort((left, right) => left - right);
  // A desktop window can be narrower than the physical monitor. Prefer the
  // browser frame in that case so a normal, non-maximised desktop window is
  // not mistaken for a zoomed car display.
  const stablePhysicalWidth = references[0] || width;
  const hasCompressedEffectiveWidth = width / stablePhysicalWidth < 0.86;
  const hasExplicitViewportScale =
    Number.isFinite(scale) && (scale || 1) > 1.05;
  const hasShortWideViewport =
    width >= 768 && height <= 700 && width / Math.max(height, 1) >= 1.5;

  return (
    hasCompressedEffectiveWidth ||
    hasExplicitViewportScale ||
    hasShortWideViewport
  );
}

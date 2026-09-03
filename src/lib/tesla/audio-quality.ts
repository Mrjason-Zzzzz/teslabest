export interface PcmSanitizeResult {
  invalidSamples: number;
  clippedSamples: number;
  peak: number;
}

/**
 * Only repairs values that WebAudio cannot safely render. It deliberately does
 * not mute a whole frame based on loudness: legitimate programme audio must not
 * be mistaken for noise.
 */
export function sanitizePcmPlaneInPlace(
  samples: Float32Array
): PcmSanitizeResult {
  let invalidSamples = 0;
  let clippedSamples = 0;
  let peak = 0;

  for (let index = 0; index < samples.length; index++) {
    const value = samples[index];
    if (!Number.isFinite(value)) {
      samples[index] = 0;
      invalidSamples++;
      continue;
    }
    const absolute = Math.abs(value);
    if (absolute > peak) peak = absolute;
    if (value > 1) {
      samples[index] = 1;
      clippedSamples++;
    } else if (value < -1) {
      samples[index] = -1;
      clippedSamples++;
    }
  }

  return { invalidSamples, clippedSamples, peak };
}

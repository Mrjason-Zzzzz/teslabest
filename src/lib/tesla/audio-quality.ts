export interface PcmSanitizeResult {
  invalidSamples: number;
  clippedSamples: number;
  peak: number;
}

export interface PcmImpulseResult {
  repairedImpulses: number;
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

/**
 * Removes only isolated full-scale one-sample impulses surrounded by near-zero
 * neighbours. This conservative live-only de-clicker does not change timing,
 * resample audio or mute a complete AAC frame.
 */
export function suppressIsolatedPcmImpulsesInPlace(
  samples: Float32Array
): PcmImpulseResult {
  let repairedImpulses = 0;
  for (let index = 1; index < samples.length - 1; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    const next = samples[index + 1];
    if (
      Math.abs(current) >= 0.95 &&
      Math.abs(previous) <= 0.1 &&
      Math.abs(next) <= 0.1 &&
      Math.abs(current - (previous + next) / 2) >= 0.85
    ) {
      samples[index] = (previous + next) / 2;
      repairedImpulses++;
    }
  }
  return { repairedImpulses };
}

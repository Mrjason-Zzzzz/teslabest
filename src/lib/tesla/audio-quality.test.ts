import { sanitizePcmPlaneInPlace } from './audio-quality';

describe('sanitizePcmPlaneInPlace', () => {
  it('repairs only invalid or out-of-range samples', () => {
    const samples = new Float32Array([0.25, Number.NaN, Infinity, 1.4, -1.2]);
    const result = sanitizePcmPlaneInPlace(samples);

    expect(Array.from(samples)).toEqual([0.25, 0, 0, 1, -1]);
    expect(result.invalidSamples).toBe(2);
    expect(result.clippedSamples).toBe(2);
    expect(result.peak).toBeCloseTo(1.4);
  });

  it('does not attenuate ordinary programme audio', () => {
    const samples = new Float32Array([-0.9, -0.2, 0, 0.35, 0.95]);
    const before = Array.from(samples);
    const result = sanitizePcmPlaneInPlace(samples);

    expect(Array.from(samples)).toEqual(before);
    expect(result.invalidSamples).toBe(0);
    expect(result.clippedSamples).toBe(0);
  });
});

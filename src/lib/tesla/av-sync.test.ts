import {
  getAvDriftAction,
  getTeslaAvSyncPolicy,
  hasFutureVideoFrame,
  hasScheduledAudioCoverage,
  shouldContinueAudioPts,
  shouldResetAudioSchedule,
} from './av-sync';

describe('Tesla live A/V sync guard', () => {
  test('keeps only small live AAC timestamp jitter continuous', () => {
    expect(shouldContinueAudioPts(10.05, 10, true)).toBe(true);
    expect(shouldContinueAudioPts(10.2, 10, true)).toBe(false);
  });

  test('holds audio before a visible live lip-sync error grows', () => {
    expect(getAvDriftAction(10, 10.13, true)).toBe('hold-audio');
  });

  test('resets the common clock for a severe live drift', () => {
    expect(getAvDriftAction(10, 10.31, true)).toBe('reset-clock');
  });

  test('does not correct normal render cadence', () => {
    expect(getAvDriftAction(10, 10.06, true)).toBe('none');
  });

  test('corrects a visible VOD drift without reacting to normal frame cadence', () => {
    expect(getAvDriftAction(10, 10.06, false)).toBe('none');
    expect(getAvDriftAction(10, 10.13, false)).toBe('hold-audio');
    expect(getAvDriftAction(10, 10.33, false)).toBe('reset-clock');
  });

  test('keeps the VOD audio queue cancellable but long enough for Tesla RAF jitter', () => {
    const policy = getTeslaAvSyncPolicy(false, 1, true);
    expect(policy.maxAudioLeadSec).toBeGreaterThanOrEqual(1.35);
    expect(policy.maxAudioLeadSec).toBeLessThanOrEqual(1.5);
    expect(policy.audioStartSafetySec).toBeLessThan(0.03);
  });

  test('does not treat a legitimate future VFR frame as video drift', () => {
    expect(hasFutureVideoFrame(10.4, 10)).toBe(true);
    expect(hasFutureVideoFrame(13, 10)).toBe(false);
    expect(hasFutureVideoFrame(9.9, 10)).toBe(false);
  });

  test('uses the actual WebAudio horizon instead of last schedule wall time', () => {
    expect(hasScheduledAudioCoverage(20.4, 20, 0.02)).toBe(true);
    expect(hasScheduledAudioCoverage(20.01, 20, 0.02)).toBe(false);
  });

  test('does not tear down scheduled sound for one ordinary timestamp wobble', () => {
    expect(shouldResetAudioSchedule(0.18, false)).toBe(false);
    expect(shouldResetAudioSchedule(0.2, true)).toBe(false);
    expect(shouldResetAudioSchedule(0.4, false)).toBe(true);
    expect(shouldResetAudioSchedule(0.35, true)).toBe(true);
  });

  test('keeps a sub-half-second live audio horizon for Tesla timer stalls', () => {
    const policy = getTeslaAvSyncPolicy(true, 1, true);
    expect(policy.maxAudioLeadSec).toBeGreaterThanOrEqual(0.4);
    expect(policy.maxAudioLeadSec).toBeLessThanOrEqual(0.5);
    expect(policy.avDriftResetSec).toBeLessThanOrEqual(0.3);
  });

  test('keeps VOD audio as master while video has a brief decode wobble', () => {
    const policy = getTeslaAvSyncPolicy(false, 1, true);
    expect(policy.avDriftConfirmMs).toBeGreaterThanOrEqual(600);
    expect(policy.avDriftResetSec).toBeLessThanOrEqual(0.32);
  });
});

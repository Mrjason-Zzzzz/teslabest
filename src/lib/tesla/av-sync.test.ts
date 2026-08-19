import {
  getAvDriftAction,
  getTeslaAvSyncPolicy,
  shouldContinueAudioPts,
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

  test('keeps the VOD audio queue short enough to cancel a sync correction', () => {
    const policy = getTeslaAvSyncPolicy(false, 1, true);
    expect(policy.maxAudioLeadSec).toBeLessThanOrEqual(0.6);
    expect(policy.audioStartSafetySec).toBeLessThan(0.03);
  });
});

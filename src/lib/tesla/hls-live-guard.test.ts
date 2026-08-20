import {
  getHlsRecoveryStartPosition,
  HlsFragmentAdmissionGuard,
  resolveLiveHiddenMediaTarget,
} from './hls-live-guard';

describe('Tesla live HLS guard', () => {
  test('admits each fragment once', () => {
    const guard = new HlsFragmentAdmissionGuard();
    const fragment = { type: 'main', cc: 4, sn: 100, start: 20 };
    expect(guard.accept(fragment)).toBe(true);
    expect(guard.accept(fragment)).toBe(false);
    expect(guard.duplicateDrops).toBe(1);
  });

  test('never lets a delayed old continuity epoch flip the decoder back', () => {
    const guard = new HlsFragmentAdmissionGuard();
    expect(guard.accept({ cc: 4, sn: 100, start: 20 })).toBe(true);
    expect(guard.accept({ cc: 5, sn: 101, start: 24 })).toBe(true);
    expect(guard.accept({ cc: 4, sn: 102, start: 28 })).toBe(false);
    expect(guard.staleDrops).toBe(1);
  });

  test('rejects a repeated or backward sequence in one continuity epoch', () => {
    const guard = new HlsFragmentAdmissionGuard();
    expect(guard.accept({ cc: 2, sn: 40, start: 80 })).toBe(true);
    expect(guard.accept({ cc: 2, sn: 39, start: 76 })).toBe(false);
  });

  test('uses the live edge for recovery and preserves VOD position', () => {
    expect(getHlsRecoveryStartPosition(true, 900, 912)).toBe(912);
    expect(getHlsRecoveryStartPosition(true, 900, null)).toBe(-1);
    expect(getHlsRecoveryStartPosition(false, 123, null)).toBe(123);
  });

  test('keeps hidden media inside the current sliding window', () => {
    expect(resolveLiveHiddenMediaTarget(12, 112, 100, 120)).toBe(112);
    expect(resolveLiveHiddenMediaTarget(108, 112, 100, 120)).toBe(108);
    expect(resolveLiveHiddenMediaTarget(180, null, 100, 120)).toBeCloseTo(
      119.9
    );
    expect(resolveLiveHiddenMediaTarget(108, null, null, null)).toBe(108);
  });
});

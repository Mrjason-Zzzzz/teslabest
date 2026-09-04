import {
  findAdSkipTarget,
  resolveVerifiedAdSkipRanges,
  toContentTimelineTime,
} from './ad-skip';

describe('Tesla verified ad skip', () => {
  test('matches only the verified source, programme and episode identity', () => {
    const matched = resolveVerifiedAdSkipRanges({
      sourceName: '量子资源',
      title: '地球超新鲜 第二季',
      episodeLabel: '20260711上',
    });
    expect(matched).toEqual([
      expect.objectContaining({ startSec: 295, endSec: 320 }),
    ]);
    expect(
      resolveVerifiedAdSkipRanges({
        sourceName: '量子资源',
        title: '地球超新鲜 第二季',
        episodeLabel: '20260712上',
      })
    ).toEqual([]);
  });

  test('suppresses the verified interval and keeps a continuous content clock', () => {
    const ranges = [{ startSec: 295, endSec: 320, reason: 'test' }];
    expect(findAdSkipTarget(294.99, ranges)).toBeNull();
    expect(findAdSkipTarget(295, ranges)).toBe(320);
    expect(findAdSkipTarget(319.99, ranges)).toBe(320);
    expect(findAdSkipTarget(320, ranges)).toBeNull();
    expect(toContentTimelineTime(294, ranges)).toBe(294);
    expect(toContentTimelineTime(300, ranges)).toBe(295);
    expect(toContentTimelineTime(320, ranges)).toBe(295);
    expect(toContentTimelineTime(330, ranges)).toBe(305);
  });
});
